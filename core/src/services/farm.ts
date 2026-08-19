/**
 * 自己的农场操作 - 收获/浇水/除草/除虫/铲除/种植/商店/巡田
 */

import type { LandType } from './farm-land-domain';
const { CONFIG, PlantPhase, PHASE_NAMES } = require('../config/config');
const { getPlantName, getPlantGrowTime, getPlantById, getSeedImageBySeedId, deriveSeedIdFromPlantId } = require('../config/gameConfig');
const { isAutomationOn, getAutomation, getPlantingStrategy, getBagSeedFallbackStrategy, getFertilizerBuyOrganicCount, getFertilizerBuyOrganicThresholdHours, getFertilizerBuyNormalCount, getFertilizerBuyNormalThresholdHours, getFertilizerBuyCheckIntervalMinutes } = require('../models/store');
const { sendMsgAsync, getUserState, networkEvents } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, getServerTimeSec, toTimeSec, log, logWarn, sleep, randomDelay } = require('../utils/utils');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');
const { checkAndBuyFertilizerBoth } = require('./mall');
const {
    getAvailableSeeds,
    getPlantingStrategyLabel,
    plantFromBagSeeds,
    plantFromShop,
} = require('./farm-planting');
const {
    ALL_FERTILIZER_LAND_TYPES,
    analyzeLands,
    buildLandMap,
    buildSlaveToMasterMap,
    classifyHarvestedLandsByMap,
    filterLandIdsByTypes,
    formatFertilizerLandTypes,
    getCurrentPhase,
    getDisplayLandContext,
    getFastMatureLands,
    getLandTypeByLevel,
    getOrganicFertilizerTargetsFromLands,
    isOccupiedSlaveLand,
    normalizeFertilizerLandTypes,
    summarizeLandDetails,
} = require('./farm-land-domain');

type DynamicRecord = Record<string, any>;
type OperationLimitsCallback = ((limits: unknown) => void) | null;

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

// ============ 内部状态 ============
let isCheckingFarm = false;
let isFirstFarmCheck = true;
let farmLoopRunning = false;
let externalSchedulerMode = false;
let fertilizerBuyCheckTimer: NodeJS.Timeout | null = null;
const farmScheduler = createScheduler('farm');
const MAX_ORGANIC_FERTILIZE_OPERATIONS = 240;
const MAX_ORGANIC_FERTILIZE_ROUNDS = 20;

function getOrganicFertilizeOperationLimit(landCount: unknown): number {
    const count = Math.max(0, Math.trunc(Number(landCount) || 0));
    return Math.min(MAX_ORGANIC_FERTILIZE_OPERATIONS, count * MAX_ORGANIC_FERTILIZE_ROUNDS);
}

// ============ 农场 API ============

// 操作限制更新回调 (由 friend.js 设置)
let onOperationLimitsUpdate: OperationLimitsCallback = null;
function setOperationLimitsCallback(callback: OperationLimitsCallback): void {
    onOperationLimitsUpdate = callback;
}

/**
 * 通用植物操作请求
 */
async function sendPlantRequest(
    RequestType: DynamicRecord,
    ReplyType: DynamicRecord,
    method: string,
    landIds: unknown[],
    hostGid: unknown,
): Promise<DynamicRecord> {
    const body = RequestType.encode(RequestType.create({
        land_ids: landIds,
        host_gid: toLong(hostGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body);
    return ReplyType.decode(replyBody);
}

async function getAllLands(): Promise<DynamicRecord> {
    const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
    const reply = types.AllLandsReply.decode(replyBody);
    // 更新操作限制
    if (reply.operation_limits && onOperationLimitsUpdate) {
        onOperationLimitsUpdate(reply.operation_limits);
    }
    return reply;
}

async function harvest(landIds: unknown[]): Promise<DynamicRecord> {
    const state = getUserState();
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    return types.HarvestReply.decode(replyBody);
}

async function waterLand(landIds: unknown[]): Promise<DynamicRecord> {
    const state = getUserState();
    return sendPlantRequest(types.WaterLandRequest, types.WaterLandReply, 'WaterLand', landIds, state.gid);
}

async function weedOut(landIds: unknown[]): Promise<DynamicRecord> {
    const state = getUserState();
    return sendPlantRequest(types.WeedOutRequest, types.WeedOutReply, 'WeedOut', landIds, state.gid);
}

async function insecticide(landIds: unknown[]): Promise<DynamicRecord> {
    const state = getUserState();
    return sendPlantRequest(types.InsecticideRequest, types.InsecticideReply, 'Insecticide', landIds, state.gid);
}

// 普通肥料 ID
const NORMAL_FERTILIZER_ID = 1011;
// 有机肥料 ID
const ORGANIC_FERTILIZER_ID = 1012;

/**
 * 施肥 - 必须逐块进行，服务器不支持批量
 * 游戏中拖动施肥间隔很短，这里用 50ms
 */
async function fertilize(landIds: unknown[], fertilizerId = NORMAL_FERTILIZER_ID): Promise<number> {
    let successCount = 0;
    for (const landId of landIds) {
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(fertilizerId),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        } catch {
            // 施肥失败（可能肥料不足），停止继续
            break;
        }
        if (landIds.length > 1) await sleep(50);  // 50ms 间隔
    }
    return successCount;
}

/**
 * 有机肥循环施肥:
 * 按地块顺序循环施肥，失败或达到单次安全上限时停止。
 */
async function fertilizeOrganicLoop(landIds: unknown[]): Promise<number> {
    const ids = (Array.isArray(landIds) ? landIds : []).filter(Boolean);
    if (ids.length === 0) return 0;

    let successCount = 0;
    let idx = 0;
    const operationLimit = getOrganicFertilizeOperationLimit(ids.length);

    while (successCount < operationLimit) {
        const landId = ids[idx];
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(ORGANIC_FERTILIZER_ID),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        } catch {
            // 常见是有机肥耗尽，按需求直接停止
            break;
        }

        idx = (idx + 1) % ids.length;
        await randomDelay(1000, 1500);
    }

    if (successCount >= operationLimit) {
        logWarn('施肥', `有机肥循环达到单次上限 ${operationLimit}，已停止继续请求`);
    }

    return successCount;
}

async function runFertilizerByConfig(
    plantedLands: unknown[] = [],
    options: { reason?: unknown; skipNormal?: boolean } = {},
): Promise<{ normal: number; organic: number }> {
    const automation = getAutomation() || {};
    const fertilizerConfig = automation.fertilizer || 'none';
    const reason = String(options.reason || '').trim().toLowerCase() === 'multi_season' ? 'multi_season' : 'normal';
    const reasonLabel = reason === 'multi_season' ? '多季补肥' : '常规施肥';
    const eventName = reason === 'multi_season' ? '多季节施肥' : '常规施肥';
    const selectedLandTypes = normalizeFertilizerLandTypes(automation.fertilizer_land_types);
    const selectedLandTypeNames = formatFertilizerLandTypes(selectedLandTypes);
    const planted = [...new Set((Array.isArray(plantedLands) ? plantedLands : []).map(v => toNum(v)).filter(Boolean))];

    if (selectedLandTypes.length === 0) {
        log('施肥', `${reasonLabel}：未勾选施肥范围，跳过本轮施肥`, {
            module: 'farm',
            event: eventName,
            result: 'skip',
            reason,
            scope: 'none',
        });
        return { normal: 0, organic: 0 };
    }

    const { skipNormal = false } = options;

    if (planted.length === 0 && fertilizerConfig !== 'organic' && fertilizerConfig !== 'both' && fertilizerConfig !== 'smart') {
        return { normal: 0, organic: 0 };
    }
    let latestLands: DynamicRecord[] = [];
    const landTypeById = new Map<number, LandType>();
    try {
        const latest = await getAllLands();
        latestLands = Array.isArray(latest && latest.lands) ? latest.lands : [];
        for (const land of latestLands) {
            if (!land) continue;
            const landId = toNum(land.id);
            if (!landId) continue;
            landTypeById.set(landId, getLandTypeByLevel(land.level));
        }
    } catch (e) {
        logWarn('施肥', `${reasonLabel}：获取土地信息失败，按已知地块继续: ${errorMessage(e)}`, {
            module: 'farm',
            event: eventName,
            result: 'error',
            reason,
        });
    }

    const isAllLandTypesSelected = selectedLandTypes.length === ALL_FERTILIZER_LAND_TYPES.length;
    if (landTypeById.size === 0 && !isAllLandTypesSelected) {
        logWarn('施肥', `${reasonLabel}：无法确认土地类型，已跳过本轮施肥`, {
            module: 'farm',
            event: eventName,
            result: 'skip',
            reason,
            landTypes: selectedLandTypes,
        });
        return { normal: 0, organic: 0 };
    }

    let normalTargets = planted;
    if (landTypeById.size > 0) {
        normalTargets = filterLandIdsByTypes(planted, landTypeById, selectedLandTypes);
    }

    let fertilizedNormal = 0;
    let fertilizedOrganic = 0;


    if (!skipNormal && (fertilizerConfig === 'normal' || fertilizerConfig === 'both' || fertilizerConfig === 'smart') && normalTargets.length > 0) {
        fertilizedNormal = await fertilize(normalTargets, NORMAL_FERTILIZER_ID);
        if (fertilizedNormal > 0) {
            log('施肥', `${reasonLabel}：已为 ${fertilizedNormal}/${normalTargets.length} 块地施普通化肥（范围: ${selectedLandTypeNames.join('、')}）`, {
            module: 'farm',
            event: eventName,
            result: 'ok',
            reason,
            type: 'normal',
            count: fertilizedNormal,
            landTypes: selectedLandTypes,
        });
            recordOperation('fertilize', fertilizedNormal);
        }
    }

    if (fertilizerConfig === 'organic' || fertilizerConfig === 'both') {
        let organicTargets = planted;

        if (latestLands.length > 0) {
            organicTargets = getOrganicFertilizerTargetsFromLands(latestLands);
        }
        if (landTypeById.size > 0) {
            organicTargets = filterLandIdsByTypes(organicTargets, landTypeById, selectedLandTypes);
            }

        fertilizedOrganic = await fertilizeOrganicLoop(organicTargets);
        if (fertilizedOrganic > 0) {
            log('施肥', `${reasonLabel}：有机化肥循环施肥完成，共施 ${fertilizedOrganic} 次（范围: ${selectedLandTypeNames.join('、')}）`, {
                module: 'farm',
                event: eventName,
                result: 'ok',
                reason,
                type: 'organic',
                count: fertilizedOrganic,
                landTypes: selectedLandTypes,
            });
            recordOperation('fertilize', fertilizedOrganic);
        }
    }
    else if (fertilizerConfig === 'smart') {
        let organicTargets: number[] = [];
        const smartSeconds = toNum(automation.fertilizer_smart_seconds) || 300;
        try {
            const latest = await getAllLands();
            organicTargets = getFastMatureLands(latest && latest.lands, smartSeconds);
        } catch (e) {
            logWarn('施肥', `获取全农场地块失败: ${errorMessage(e)}`);
        }

        if (organicTargets.length > 0) {
            fertilizedOrganic = await fertilizeOrganicLoop(organicTargets);
            if (fertilizedOrganic > 0) {
                log('施肥', `有机化肥循环施肥完成，共施 ${fertilizedOrganic} 次`, {
                    module: 'farm',
                    event: '施肥',
                    result: 'ok',
                    type: 'organic',
                    count: fertilizedOrganic,
                });
                recordOperation('fertilize', fertilizedOrganic);
            }
        }
    }

    return { normal: fertilizedNormal, organic: fertilizedOrganic };
}

async function removePlant(landIds: unknown[]): Promise<DynamicRecord> {
    const body = types.RemovePlantRequest.encode(types.RemovePlantRequest.create({
        land_ids: landIds.map(id => toLong(id)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'RemovePlant', body);
    return types.RemovePlantReply.decode(replyBody);
}

async function upgradeLand(landId: unknown): Promise<DynamicRecord> {
    const body = types.UpgradeLandRequest.encode(types.UpgradeLandRequest.create({
        land_id: toLong(landId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UpgradeLand', body);
    return types.UpgradeLandReply.decode(replyBody);
}

async function unlockLand(landId: unknown, doShared = false): Promise<DynamicRecord> {
    const body = types.UnlockLandRequest.encode(types.UnlockLandRequest.create({
        land_id: toLong(landId),
        do_shared: !!doShared,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UnlockLand', body);
    return types.UnlockLandReply.decode(replyBody);
}


async function getLandsDetail() {
    try {
        const landsReply = await getAllLands();
        if (!landsReply.lands) return { lands: [], summary: {} };
        //const status = analyzeLands(landsReply.lands);
        const nowSec = getServerTimeSec();
        const lands = [];
        const landsMap = buildLandMap(landsReply.lands);

        for (const land of landsReply.lands) {
            const id = toNum(land.id);
            const level = toNum(land.level);
            const maxLevel = toNum(land.max_level);
            const landsLevel = toNum(land.lands_level);
            const landSize = toNum(land.land_size);
            const couldUnlock = !!land.could_unlock;
            const couldUpgrade = !!land.could_upgrade;
            const {
                sourceLand,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
            } = getDisplayLandContext(land, landsMap);
            if (!land.unlocked) {
                lands.push({
                    id,
                    unlocked: false,
                    status: 'locked',
                    plantName: '',
                    phaseName: '',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster: false,
                    masterLandId: 0,
                    occupiedLandIds: [],
                    plantSize: 1,
                });
                continue;
            }
            // const plant = land.plant;
            const plant = sourceLand && sourceLand.plant;
            if (!plant || !plant.phases || plant.phases.length === 0) {
                lands.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '空地',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster,
                    masterLandId,
                    occupiedLandIds,
                    plantSize: 1,
                });
                continue;
            }
            const currentPhase = getCurrentPhase(plant.phases, false, '');
            if (!currentPhase) {
                lands.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster,
                    masterLandId,
                    occupiedLandIds,
                    plantSize: 1,
                });
                continue;
            }
            const phaseVal = currentPhase.phase;
            const plantId = toNum(plant.id);
            const plantName = getPlantName(plantId) || plant.name || '未知';
            const plantCfg = getPlantById(plantId);
            const seedId = toNum(plantCfg && plantCfg.seed_id) || deriveSeedIdFromPlantId(plantId);
            const seedImage = seedId > 0 ? getSeedImageBySeedId(seedId) : '';
            let plantSize = Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
            // 本地配置缺失的活动种子（如 29003 星语铃花）：用主格占用格数推断尺寸（4 格 → 2x2）
            if (plantSize <= 1 && occupiedLandIds.length > 1 && !occupiedByMaster) {
                plantSize = Math.round(Math.sqrt(occupiedLandIds.length));
            }
            const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
            const currentSeasonRaw = toNum(plant.season);
            const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;
            const phaseName = PHASE_NAMES[phaseVal] || '';
            const maturePhase = Array.isArray(plant.phases)
                ? plant.phases.find((phase: DynamicRecord) => phase && toNum(phase.phase) === PlantPhase.MATURE)
                : null;
            const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
            const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;
            const totalGrowTime = getPlantGrowTime(plantId);

            let landStatus = 'growing';
            if (phaseVal === PlantPhase.MATURE) landStatus = 'harvestable';
            else if (phaseVal === PlantPhase.DEAD) landStatus = 'dead';
            else if (phaseVal === PlantPhase.UNKNOWN || !plant.phases.length) landStatus = 'empty';

            const needWater = (toNum(plant.dry_num) > 0) || (toTimeSec(currentPhase.dry_time) > 0 && toTimeSec(currentPhase.dry_time) <= nowSec);
            const needWeed = (plant.weed_owners && plant.weed_owners.length > 0) || (toTimeSec(currentPhase.weeds_time) > 0 && toTimeSec(currentPhase.weeds_time) <= nowSec);
            const needBug = (plant.insect_owners && plant.insect_owners.length > 0) || (toTimeSec(currentPhase.insect_time) > 0 && toTimeSec(currentPhase.insect_time) <= nowSec);

            lands.push({
                id,
                unlocked: true,
                status: landStatus,
                plantName,
                seedId,
                seedImage,
                phaseName,
                currentSeason,
                totalSeason,
                matureInSec,
                totalGrowTime,
                needWater,
                needWeed,
                needBug,
                stealable: !!plant.stealable,
                level,
                maxLevel,
                landsLevel,
                landSize,
                couldUnlock,
                couldUpgrade,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
                plantSize,
            });
        }

        return {
            lands,

            summary: summarizeLandDetails(lands),
        };
    } catch {
        return { lands: [], summary: {} };
    }
}

async function autoPlantEmptyLands(deadLandIds: number[], emptyLandIds: number[]): Promise<void | DynamicRecord> {
    const landsToPlant: number[] = [...emptyLandIds];
    const state = getUserState();

    // 1. 铲除枯死/收获残留植物（一键操作）
    if (deadLandIds.length > 0) {
        try {
            await removePlant(deadLandIds);
            log('铲除', `已铲除 ${deadLandIds.length} 块 (${deadLandIds.join(',')})`, {
                module: 'farm', event: '铲除植物', result: 'ok', count: deadLandIds.length
            });
            landsToPlant.push(...deadLandIds);
        } catch (e) {
            logWarn('铲除', `批量铲除失败: ${errorMessage(e)}`, {
                module: 'farm', event: '铲除植物', result: 'error'
            });
            // 失败时仍然尝试种植
            landsToPlant.push(...deadLandIds);
        }
    }

    if (landsToPlant.length === 0) return;

    const accountStrategy = String(getPlantingStrategy() || '').trim();

    // 背包种子优先策略
    if (accountStrategy === 'bag_priority') {
        let bagResult;
        try {
            bagResult = await plantFromBagSeeds(landsToPlant);
        } catch (e) {
            logWarn('种植', `读取背包种子失败，本轮跳过第二优先策略以避免误购: ${errorMessage(e)}`, {
                module: 'farm',
                event: '种植种子',
                result: 'bag_load_error',
            });
            return { plantedLands: [] };
        }

        const plantedLands = bagResult.plantedLandIds || [];
        
        // 如果允许回退且有剩余空地，使用第二优先策略补种
        if (bagResult.fallbackAllowed && bagResult.remainingLandIds.length > 0) {
            const fallbackStrategy = getBagSeedFallbackStrategy() || 'level';
            log('种植', `开始按第二优先策略"${getPlantingStrategyLabel(fallbackStrategy)}"补种剩余空地`, {
                module: 'farm',
                event: '种植种子',
                result: 'fallback_start',
                strategy: fallbackStrategy,
                remainingCount: bagResult.remainingLandIds.length,
            });
            const shopResult = await plantFromShop(bagResult.remainingLandIds, state, fallbackStrategy);
            plantedLands.push(...(shopResult.plantedLands || []));
        }

        // 施肥
        if (plantedLands.length > 0) {
            await runFertilizerByConfig(plantedLands);
        }
        return;
    }

    // 其他策略：从商店购买种植
    const shopResult = await plantFromShop(landsToPlant, state);
    if (shopResult.plantedLands && shopResult.plantedLands.length > 0) {
        await runFertilizerByConfig(shopResult.plantedLands);
    }
}


async function resolveRemovableHarvestedLands(harvestedLandIds: number[], harvestReply: DynamicRecord | null) {
    const ids = Array.isArray(harvestedLandIds) ? harvestedLandIds.filter(Boolean) : [];
    if (ids.length === 0) {
        return { removable: [], growing: [], fallbackRemoved: 0 };
    }

    const replyMap = buildLandMap(harvestReply && harvestReply.land);
    const firstPass = classifyHarvestedLandsByMap(ids, replyMap);
    const removable = [...firstPass.removable];
    const growing = [...firstPass.growing];
    let unknown = [...firstPass.unknown];
    let fallbackRemoved = 0;

    if (unknown.length > 0) {
        try {
            const latestLandsReply = await getAllLands();
            const latestMap = buildLandMap(latestLandsReply && latestLandsReply.lands);
            const secondPass = classifyHarvestedLandsByMap(unknown, latestMap);
            removable.push(...secondPass.removable);
            growing.push(...secondPass.growing);
            unknown = secondPass.unknown;
        } catch (e) {
            logWarn('农场', `收后状态补拉失败: ${errorMessage(e)}`, {
                module: 'farm',
                event: '收获后状态补拉',
                result: 'error',
            });
        }
    }

    if (unknown.length > 0) {
        // 按兼容策略：不可判定时保持旧行为，继续铲除
        removable.push(...unknown);
        fallbackRemoved = unknown.length;
    }

    return {
        removable: [...new Set(removable)],
        growing: [...new Set(growing)],
        fallbackRemoved,
    };
}

async function checkFarm(): Promise<boolean> {
    const state = getUserState();
    if (isCheckingFarm || !state.gid || !isAutomationOn('farm')) return false;
    isCheckingFarm = true;

    try {
        // 复用手动操作逻辑
        const result = await runFarmOperation('all');
        isFirstFarmCheck = false;
        return !!(result && result.hadWork);
    } catch (err) {
        logWarn('巡田', `检查失败: ${errorMessage(err)}`);
        return false;
    } finally {
        isCheckingFarm = false;
    }
}

async function harvestMatureOwnLandsOnce(actions: string[]): Promise<number> {
    let latest: DynamicRecord;
    try {
        latest = await getAllLands();
    } catch (e) {
        logWarn('收获', `施肥后刷新土地失败: ${errorMessage(e)}`);
        return 0;
    }

    const lands = Array.isArray(latest?.lands) ? latest.lands : [];
    const harvestable = lands.length > 0 ? analyzeLands(lands, false).harvestable : [];
    if (!Array.isArray(harvestable) || harvestable.length === 0) return 0;

    try {
        await harvest(harvestable);
        actions.push(`施肥后收获${harvestable.length}`);
        recordOperation('harvest', harvestable.length);
        networkEvents.emit('farmHarvested', {
            count: harvestable.length,
            landIds: [...harvestable],
            opType: 'fertilizer_followup',
        });
        log('收获', `施肥后立即收获 ${harvestable.length} 块土地`, {
            module: 'farm',
            event: '施肥后收获作物',
            result: 'ok',
            count: harvestable.length,
            landIds: [...harvestable],
        });
        return harvestable.length;
    } catch (e) {
        logWarn('收获', `施肥后立即收获失败: ${errorMessage(e)}`, {
            module: 'farm',
            event: '施肥后收获作物',
            result: 'error',
        });
        return 0;
    }
}

/**
 * 手动/自动执行农场操作
 * @param {string} opType - 'all', 'harvest', 'clear', 'plant', 'upgrade'
 */
async function runFarmOperation(opType: string) {
    const landsReply = await getAllLands();
    if (!landsReply.lands || landsReply.lands.length === 0) {
        if (opType !== 'all') {
            log('农场', '没有土地数据');
        }
        return { hadWork: false, actions: [] };
    }

    const lands = landsReply.lands;

    const status = analyzeLands(lands, isFirstFarmCheck);

    // 摘要
    const statusParts: string[] = [];
    if (status.harvestable.length) statusParts.push(`收:${status.harvestable.length}`);
    if (status.needWeed.length) statusParts.push(`草:${status.needWeed.length}`);
    if (status.needBug.length) statusParts.push(`虫:${status.needBug.length}`);
    if (status.needWater.length) statusParts.push(`水:${status.needWater.length}`);
    if (status.dead.length) statusParts.push(`枯:${status.dead.length}`);
    if (status.empty.length) statusParts.push(`空:${status.empty.length}`);
    if (status.unlockable.length) statusParts.push(`解:${status.unlockable.length}`);
    if (status.upgradable.length) statusParts.push(`升:${status.upgradable.length}`);
    statusParts.push(`长:${status.growing.length}`);

    const actions: string[] = [];

    // 执行除草/虫/水 - 串行执行以降低并发压力
    if (opType === 'all' || opType === 'clear') {
        // 检查是否跳过自己农场的草虫（仅自动模式生效，手动clear不受影响）
        const skipOwnWeedBug = opType === 'all' && isAutomationOn('skip_own_weed_bug');
        if (status.needWeed.length > 0 && !skipOwnWeedBug) {
            try {
                await weedOut(status.needWeed);
                actions.push(`除草${status.needWeed.length}`);
                recordOperation('weed', status.needWeed.length);
            } catch (e) {
                logWarn('除草', errorMessage(e));
            }
        }
        if (status.needBug.length > 0 && !skipOwnWeedBug) {
            try {
                await insecticide(status.needBug);
                actions.push(`除虫${status.needBug.length}`);
                recordOperation('bug', status.needBug.length);
            } catch (e) {
                logWarn('除虫', errorMessage(e));
            }
        }
        if (status.needWater.length > 0) {
            try {
                await waterLand(status.needWater);
                actions.push(`浇水${status.needWater.length}`);
                recordOperation('water', status.needWater.length);
            } catch (e) {
                logWarn('浇水', errorMessage(e));
            }
        }
    }

    // 执行收获
    let harvestedLandIds: number[] = [];
    let harvestReply: DynamicRecord | null = null;
    let postHarvest: DynamicRecord | null = null;
    if (opType === 'all' || opType === 'harvest') {
        if (status.harvestable.length > 0) {
            try {
                harvestReply = await harvest(status.harvestable);
                log('收获', `收获完成 ${status.harvestable.length} 块土地`, {
                    module: 'farm',
                    event: '收获作物',
                    result: 'ok',
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                });
                actions.push(`收获${status.harvestable.length}`);
                recordOperation('harvest', status.harvestable.length);
                harvestedLandIds = [...status.harvestable];
                networkEvents.emit('farmHarvested', {
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                    opType,
                });
            } catch (e) {
                logWarn('收获', errorMessage(e), {
                    module: 'farm',
                    event: '收获作物',
                    result: 'error',
                });
            }
        }
    }

    // 执行种植
    if (opType === 'all' || opType === 'plant') {
        const allEmptyLands = [...new Set<number>(status.empty as number[])];
        let allDeadLands = [...new Set<number>(status.dead as number[])];

        if (opType === 'all' && harvestedLandIds.length > 0) {
            // 收获后延迟再铲除枯地
            await randomDelay(1000, 1500);
            //const postHarvest = await resolveRemovableHarvestedLands(harvestedLandIds, harvestReply);
            postHarvest = await resolveRemovableHarvestedLands(harvestedLandIds, harvestReply);
            allDeadLands = [...new Set([...allDeadLands, ...postHarvest.removable])];
        }
        // 注意：如果是单纯点"一键种植"，harvestedLandIds 为空，只种当前的空地/死地
        if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
            try {
                const plantCount = allDeadLands.length + allEmptyLands.length;
                await autoPlantEmptyLands(allDeadLands, allEmptyLands);
                actions.push(`种植${plantCount}`);
                recordOperation('plant', plantCount);
            } catch (e) { logWarn('种植', errorMessage(e)); }
        }
    }
    if (opType === 'all' && postHarvest && Array.isArray(postHarvest.growing) && postHarvest.growing.length > 0 && isAutomationOn('fertilizer_multi_season')) {
        const multiSeasonTargets = [...new Set(postHarvest.growing.map(v => toNum(v)).filter(Boolean))];
        if (multiSeasonTargets.length > 0) {
            log('施肥', `检测到多季作物进入后续季，准备执行多季补肥，目标地块 ${multiSeasonTargets.length} 块`, {
                module: 'farm',
                event: '多季节施肥',
                result: 'trigger',
                count: multiSeasonTargets.length,
                landIds: multiSeasonTargets,
            });
            try {
                await runFertilizerByConfig(multiSeasonTargets, { reason: 'multi_season' });
            } catch (e) {
                logWarn('施肥', `多季补肥执行失败: ${errorMessage(e)}`, {
                    module: 'farm',
                    event: '多季节施肥',
                    result: 'error',
                });
            }
        }
    }

    // 执行土地解锁/升级（手动 upgrade 总是执行；自动 all 受开关控制）
    const shouldAutoUpgrade = opType === 'all' && isAutomationOn('land_upgrade');
    if (shouldAutoUpgrade || opType === 'upgrade') {
        if (status.unlockable.length > 0) {
            let unlocked = 0;
            for (const landId of status.unlockable) {
                try {
                    await unlockLand(landId, false);
                    log('解锁', `土地#${landId} 解锁成功`, {
                        module: 'farm', event: '解锁土地', result: 'ok', landId
                    });
                    unlocked++;
                } catch (e) {
                    logWarn('解锁', `土地#${landId} 解锁失败: ${errorMessage(e)}`, {
                        module: 'farm', event: '解锁土地', result: 'error', landId
                    });
                }
                await randomDelay(1000, 1500);
            }
            if (unlocked > 0) {
                actions.push(`解锁${unlocked}`);
            }
        }

        if (status.upgradable.length > 0) {
            let upgraded = 0;
            for (const landId of status.upgradable) {
                try {
                    const reply = await upgradeLand(landId);
                    const newLevel = reply.land ? toNum(reply.land.level) : '?';
                    log('升级', `土地#${landId} 升级成功 → 等级${newLevel}`, {
                        module: 'farm', event: '升级土地', result: 'ok', landId, level: newLevel
                    });
                    upgraded++;
                } catch (e) {
                    log('升级', `土地#${landId} 升级失败: ${errorMessage(e)}`, {
                        module: 'farm', event: '升级土地', result: 'error', landId
                    });
                }
                await randomDelay(1000, 1500);
            }
            if (upgraded > 0) {
                actions.push(`升级${upgraded}`);
                recordOperation('upgrade', upgraded);
            }
        }
    }

    if (opType === 'all') {
        const fertilizerConfig = getAutomation().fertilizer || 'none';
        if (fertilizerConfig === 'smart') {
            try {
                const result = await runFertilizerByConfig([], { skipNormal: true });
                if (result.organic > 0) {
                    actions.push(`有机肥${result.organic}`);
                    await harvestMatureOwnLandsOnce(actions);
                }
            } catch (e) {
                logWarn('施肥', `巡田时施肥失败: ${errorMessage(e)}`);
            }
        }
    }
    // 日志
    const actionStr = actions.length > 0 ? ` → ${actions.join('/')}` : '';
    if (actions.length > 0) {
         log('农场', `[${statusParts.join(' ')}]${actionStr}`, {
             module: 'farm', event: '农场循环', opType, actions
         });
    }
    return { hadWork: actions.length > 0, actions };
}

function scheduleNextFarmCheck(delayMs = CONFIG.farmCheckInterval): void {
    if (externalSchedulerMode) return;
    if (!farmLoopRunning) return;
    farmScheduler.setTimeoutTask('farm_check_loop', Math.max(0, delayMs), async () => {
        if (!farmLoopRunning) return;
        await checkFarm();
        if (!farmLoopRunning) return;
        scheduleNextFarmCheck(CONFIG.farmCheckInterval);
    });
}

function startFarmCheckLoop(options: { externalScheduler?: boolean } = {}): void {
    if (farmLoopRunning) return;
    externalSchedulerMode = !!options.externalScheduler;
    farmLoopRunning = true;
    networkEvents.on('landsChanged', onLandsChangedPush);
    if (!externalSchedulerMode) {
        scheduleNextFarmCheck(2000);
    }
    // 启动化肥自动购买检测定时器
    startFertilizerBuyCheckTimer();
}

let lastPushTime = 0;
function onLandsChangedPush(lands: DynamicRecord[]): void {
    if (!isAutomationOn('farm_push')) {
        return;
    }
    if (isCheckingFarm) return;
    const now = Date.now();
    if (now - lastPushTime < 500) return;
    lastPushTime = now;
    log('农场', `收到推送: ${lands.length}块土地变化，检查中...`, {
        module: 'farm', event: '土地推送通知', result: 'trigger_check', count: lands.length
    });
    farmScheduler.setTimeoutTask('farm_push_check', 100, async () => {
        if (!isCheckingFarm) await checkFarm();
    });
}

function stopFarmCheckLoop(): void {
    farmLoopRunning = false;
    externalSchedulerMode = false;
    farmScheduler.clearAll();
    networkEvents.removeListener('landsChanged', onLandsChangedPush);
    // 停止化肥自动购买检测定时器
    stopFertilizerBuyCheckTimer();
}

function refreshFarmCheckLoop(delayMs = 200): void {
    if (!farmLoopRunning) return;
    scheduleNextFarmCheck(delayMs);
}

// ============ 化肥自动购买定时检测 ============
function startFertilizerBuyCheckTimer(): void {
    if (fertilizerBuyCheckTimer) {
        clearInterval(fertilizerBuyCheckTimer);
    }
    
    // 检查是否有开启的化肥购买功能
    if (!isAutomationOn('fertilizer_buy_organic') && !isAutomationOn('fertilizer_buy_normal')) {
        return;
    }
    
    // 设置定时检测
    const intervalMinutes = getFertilizerBuyCheckIntervalMinutes();
    const intervalMs = intervalMinutes * 60 * 1000;
    
    fertilizerBuyCheckTimer = setInterval(() => {
        checkFertilizerBuyOnce();
    }, intervalMs);
    
    log('农场', `化肥自动购买检测定时器已启动，间隔 ${intervalMinutes} 分钟`, {
        module: 'farm',
        event: '购买化肥计时器',
        result: 'start',
        intervalMinutes,
    });
}

function stopFertilizerBuyCheckTimer(): void {
    if (fertilizerBuyCheckTimer) {
        clearInterval(fertilizerBuyCheckTimer);
        fertilizerBuyCheckTimer = null;
    }
    log('农场', '化肥自动购买检测定时器已停止', {
        module: 'farm',
        event: '购买化肥计时器',
        result: 'stop',
    });
}

async function checkFertilizerBuyOnce(): Promise<void> {
    if (!isAutomationOn('fertilizer_buy_organic') && !isAutomationOn('fertilizer_buy_normal')) {
        return;
    }
    
    try {
        const options = {
            buyOrganic: isAutomationOn('fertilizer_buy_organic'),
            buyNormal: isAutomationOn('fertilizer_buy_normal'),
            organicCount: getFertilizerBuyOrganicCount(),
            organicThresholdHours: getFertilizerBuyOrganicThresholdHours(),
            normalCount: getFertilizerBuyNormalCount(),
            normalThresholdHours: getFertilizerBuyNormalThresholdHours(),
        };

        await checkAndBuyFertilizerBoth(options);
    } catch (e) {
        const message = errorMessage(e);
        logWarn('农场', `化肥自动购买检测失败: ${message}`, {
            module: 'farm',
            event: 'fertilizer_auto_buy',
            result: 'error',
            error: message,
        });
    }
}

export {
    buildLandMap,
    buildSlaveToMasterMap,
    checkFarm,
    getAllLands,
    getAvailableSeeds,
    getCurrentPhase,
    getDisplayLandContext,
    getLandsDetail,
    getOrganicFertilizeOperationLimit,
    isOccupiedSlaveLand,
    refreshFarmCheckLoop,
    runFarmOperation,
    runFertilizerByConfig,
    setOperationLimitsCallback,
    startFarmCheckLoop,
    stopFarmCheckLoop,
};
