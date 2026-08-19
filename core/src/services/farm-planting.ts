/**
 * 农场种植与种子商店策略
 */

const protobuf = require('protobufjs');
const {
    formatGrowTime,
    getAllSeeds,
    getPlantGrowTime,
    getPlantNameBySeedId,
    getPlantSizeBySeedId,
} = require('../config/gameConfig');
const {
    getBagSeedPriority,
    getPlantingStrategy,
    getPreferredSeed,
} = require('../models/store');
const { getUserState, getWsErrorState, sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, logWarn, sleep, toLong, toNum } = require('../utils/utils');
const { getPlantRankings } = require('./analytics');
const {
    buildLandMap,
    findEmptyLandQuads,
    getDisplayLandContext,
} = require('./farm-land-domain');
const { getBagSeeds } = require('./warehouse');

type DynamicRecord = Record<string, any>;

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

// ============ 商店 API ============

async function getShopInfo(shopId: unknown): Promise<DynamicRecord> {
    const body = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({
        shop_id: toLong(shopId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', body);
    return types.ShopInfoReply.decode(replyBody);
}

async function buyGoods(goodsId: unknown, num: unknown, price: unknown): Promise<DynamicRecord> {
    const body = types.BuyGoodsRequest.encode(types.BuyGoodsRequest.create({
        goods_id: toLong(goodsId),
        num: toLong(num),
        price: toLong(price),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'BuyGoods', body);
    return types.BuyGoodsReply.decode(replyBody);
}

// ============ 种植 ============

function encodePlantRequest(seedId: unknown, landIds: unknown[], autoSlave = false): Uint8Array {
    const writer = protobuf.Writer.create();
    const itemWriter = writer.uint32(18).fork();
    itemWriter.uint32(8).int64(seedId);
    const idsWriter = itemWriter.uint32(18).fork();
    for (const id of landIds) {
        idsWriter.int64(id);
    }
    idsWriter.ldelim();
    // field 3 auto_slave=true：多格作物（2x2）自动占用从属格/自动整合（缺省 false 时多格种植被服务端拒绝 1001052）
    if (autoSlave) itemWriter.uint32(24).bool(true);
    itemWriter.ldelim();
    return writer.finish();
}

/**
 * 种植 - 游戏中拖动种植间隔很短，这里用 50ms
 */
// async function plantSeeds(seedId, landIds) {
async function plantSeeds(
    seedId: unknown,
    landIds: unknown[],
    options: { maxPlantCount?: unknown; quadGroups?: unknown[] } = {},
) {
    let successCount = 0;
    // for (const landId of landIds) {
    const plantedLandIds: number[] = [];
    const occupiedLandIds = new Set<number>();
    const failedErrorCodes = new Set<string>();
    const maxPlantCount = Math.max(0, toNum(options.maxPlantCount) || 0) || Number.POSITIVE_INFINITY;
    const pendingLandIds = new Set((Array.isArray(landIds) ? landIds : []).map(id => toNum(id)).filter(Boolean));
    const quadGroups = Array.isArray(options.quadGroups) ? options.quadGroups : null;
    const usedLandIds = new Set();

    // 2x2 作物：每个已选组合只提交主格，服务端根据 auto_slave 自动占用从属格。
    if (quadGroups && quadGroups.length > 0) {
        for (const group of quadGroups) {
            if (successCount >= maxPlantCount) break;
            const groupIds = (Array.isArray(group) ? group : []).map(id => toNum(id)).filter(Boolean);
            if (groupIds.length < 4) continue;
            const masterLandId = groupIds[0];
            // 防御：与已处理组重叠的地块跳过（findEmptyLandQuads 保证不相交；防未来调用方误传重叠组）
            if (groupIds.some(id => usedLandIds.has(id))) continue;
            try {
                const body = encodePlantRequest(seedId, [masterLandId], true);
                const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', body);
                const reply = types.PlantReply.decode(replyBody);
                const changedLands = Array.isArray(reply && reply.land) ? reply.land : [];
                const changedMap = buildLandMap(changedLands);
                const selfLand = changedMap.get(masterLandId);
                const displayContext = getDisplayLandContext(selfLand || { id: masterLandId }, changedMap);
                const occupiedIds = [...new Set([
                    ...groupIds,
                    ...displayContext.occupiedLandIds,
                ])];
                successCount++;
                plantedLandIds.push(displayContext.masterLandId || masterLandId);
                for (const occupiedId of occupiedIds) {
                    occupiedLandIds.add(occupiedId);
                    usedLandIds.add(occupiedId);
                }
            } catch (e) {
                const msg = errorMessage(e);
                const codeMatch = msg.match(/code=(\d+)/);
                if (codeMatch && codeMatch[1]) failedErrorCodes.add(codeMatch[1]);
                logWarn('种植', `2x2 主格#${masterLandId}（占地 [${groupIds.join(',')}]）失败: ${msg}`);
                // 失败也标记已用，避免后续组重叠请求同一批地块
                for (const id of groupIds) usedLandIds.add(id);
            }
            await sleep(50);  // 50ms 间隔
        }
        return {
            planted: successCount,
            plantedLandIds,
            occupiedLandIds: [...occupiedLandIds],
            failedErrorCodes: [...failedErrorCodes],
        };
    }

    for (const rawLandId of landIds) {
        const landId = toNum(rawLandId);
        if (!landId || !pendingLandIds.has(landId)) continue;
        if (successCount >= maxPlantCount) break;
        try {
            const body = encodePlantRequest(seedId, [landId]);
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', body);
            // types.PlantReply.decode(replyBody);
            const reply = types.PlantReply.decode(replyBody);
            const changedLands = Array.isArray(reply && reply.land) ? reply.land : [];
            const changedMap = buildLandMap(changedLands);
            const selfLand = changedMap.get(landId);
            const displayContext = getDisplayLandContext(selfLand || { id: landId }, changedMap);
            const occupiedIds = displayContext.occupiedLandIds.length > 0
                ? displayContext.occupiedLandIds
                : [landId];
            successCount++;
            plantedLandIds.push(displayContext.masterLandId || landId);
            for (const occupiedId of occupiedIds) {
                occupiedLandIds.add(occupiedId);
                pendingLandIds.delete(occupiedId);
            }
        } catch (e) {
            const msg = errorMessage(e);
            const codeMatch = msg.match(/code=(\d+)/);
            if (codeMatch && codeMatch[1]) failedErrorCodes.add(codeMatch[1]);
            logWarn('种植', `土地#${landId} 失败: ${msg}`);
        }
        if (landIds.length > 1) await sleep(50);  // 50ms 间隔
    }
    return {
        planted: successCount,
        plantedLandIds,
        occupiedLandIds: [...occupiedLandIds],
        failedErrorCodes: [...failedErrorCodes],
    };
}

const PLANTING_STRATEGY_LABELS = {
    preferred: '优先种植种子',
    level: '最高等级作物',
    max_exp: '最大经验/时',
    max_fert_exp: '最大普通肥经验/时',
    max_profit: '最大净利润/时',
    max_fert_profit: '最大普通肥净利润/时',
    bag_priority: '背包种子优先',
};

function getPlantingStrategyLabel(strategy: unknown): string {
    const key = String(strategy || '');
    return PLANTING_STRATEGY_LABELS[key as keyof typeof PLANTING_STRATEGY_LABELS] || key;
}

// 种植失败学习缓存：seedId -> { reason, at }（本 worker 内存，重启清空）
// 用于跳过"地块不匹配"的种子（如 2x2 作物种到 1x1 地块），避免每轮反复失败
const unplantableSeeds = new Map<number, DynamicRecord>();
const UNPLANTABLE_LEARN_TTL = 60 * 60 * 1000; // 1 小时后允许重试（地块可能升级）

function sortBagSeedsForPlanting(bagSeeds: DynamicRecord[], priorityList: unknown[]): DynamicRecord[] {
    const indexMap = new Map<number, number>();
    const priority = Array.isArray(priorityList) ? priorityList : [];
    priority.forEach((seedId, index) => {
        const id = Number(seedId);
        if (id > 0) indexMap.set(id, index);
    });

    return [...(Array.isArray(bagSeeds) ? bagSeeds : [])].sort((a, b) => {
        const aIndex = indexMap.get(a.seedId) ?? Number.MAX_SAFE_INTEGER;
        const bIndex = indexMap.get(b.seedId) ?? Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;

        const aLevel = Number(a.requiredLevel || 0);
        const bLevel = Number(b.requiredLevel || 0);
        if (aLevel !== bLevel) return bLevel - aLevel;

        return Number(a.seedId || 0) - Number(b.seedId || 0);
    });
}

async function plantFromBagSeeds(landsToPlant: number[]) {
    const targetLandIds = (Array.isArray(landsToPlant) ? landsToPlant : []).map(id => Number(id)).filter(id => id > 0);
    if (targetLandIds.length === 0) {
        return { remainingLandIds: [], fallbackAllowed: false, plantedLandIds: [], totalPlanted: 0, occupiedCount: 0 };
    }

    const bagSeeds = await getBagSeeds();
    const allBagSeeds = Array.isArray(bagSeeds) ? bagSeeds : [];
    const usableSeeds = sortBagSeedsForPlanting(
        // 1x1 与 2x2 种子都进候选（2x2 由 is2x2 分支选主格种植）
        allBagSeeds.filter(seed => Number(seed && seed.count) > 0 && Number(seed && seed.plantSize) >= 1),
        getBagSeedPriority(),
    );

    if (usableSeeds.length === 0) {
        const hasAnyBagSeed = allBagSeeds.some(seed => Number(seed && seed.count) > 0);
        log('种植', hasAnyBagSeed
            ? '背包中没有可用的 1x1 种子，准备按第二优先策略补种'
            : '背包种子已用完，准备按第二优先策略补种', {
            module: 'farm',
            event: '种植种子',
            result: 'fallback_ready',
            strategy: 'bag_priority',
        });
        return { remainingLandIds: targetLandIds, fallbackAllowed: true, plantedLandIds: [], totalPlanted: 0, occupiedCount: 0 };
    }

    let remainingLandIds = [...targetLandIds];
    let fallbackAllowed = true;
    let totalPlanted = 0;
    let occupiedCount = 0;
    const plantedLandIds = [];
    const usedSeedLogs = [];

    for (const seed of usableSeeds) {
        if (remainingLandIds.length === 0) break;

        // 失败学习：此前整轮种植失败（如 2x2 作物种到 1x1 地块）的种子，改为按 2x2 主格重试或跳过
        const learned = unplantableSeeds.get(seed.seedId);
        const plantSize = getPlantSizeBySeedId(seed.seedId, seed.plantSize);
        const is2x2 = plantSize > 1 || (learned && learned.codes && learned.codes.includes('1001052'));
        if (learned && !is2x2 && Date.now() - learned.at < UNPLANTABLE_LEARN_TTL) {
            log('种植', `种子 ${seed.name} 已学习跳过（${learned.reason}），本轮不尝试`, {
                module: 'farm', event: '种植种子', result: 'learned_skip', seedId: seed.seedId,
            });
            continue;
        }
        if (learned && !is2x2) unplantableSeeds.delete(seed.seedId); // TTL 过期，允许重试

        const maxPlantCount = Math.min(Number(seed.count || 0), remainingLandIds.length);
        if (maxPlantCount <= 0) continue;

        // 2x2 作物：从当前空地选择数量最多且互不重叠的相邻四格，并将左下格作为主格。
        const targetLands = remainingLandIds;
        let quadGroups = null;
        let plannedPlantCount = maxPlantCount;
        if (is2x2) {
            quadGroups = findEmptyLandQuads(remainingLandIds);
            if (quadGroups.length === 0) {
                log('种植', `种子 ${seed.name} 为 ${plantSize}x${plantSize} 作物，当前空地无法组成 2x2，本轮跳过`, {
                    module: 'farm', event: '种植种子', result: 'no_2x2_quads', seedId: seed.seedId,
                });
                continue;
            }
            plannedPlantCount = Math.min(Number(seed.count || 0), quadGroups.length);
        }

        const result = await plantSeeds(seed.seedId, targetLands, quadGroups
            ? { quadGroups, maxPlantCount: plannedPlantCount }
            : { maxPlantCount: plannedPlantCount });
        const currentOccupied = (Array.isArray(result.occupiedLandIds) ? result.occupiedLandIds : []).map(Number).filter(id => id > 0);
        const currentPlantedLandIds = (Array.isArray(result.plantedLandIds) ? result.plantedLandIds : []).map(Number).filter(id => id > 0);
        if (result.planted > 0) {
            totalPlanted += result.planted;
            occupiedCount += currentOccupied.length > 0 ? currentOccupied.length : result.planted;
            plantedLandIds.push(...currentPlantedLandIds);
            remainingLandIds = remainingLandIds.filter(id => !currentOccupied.includes(id));
            usedSeedLogs.push(`${seed.name}x${result.planted}`);
        }

        if (result.planted === 0 && result.failedErrorCodes.length > 0) {
            // 整轮全部失败：记入失败学习（地块不匹配/多格作物等），不阻断第二优先策略回退
            const reason = result.failedErrorCodes.includes('1001052')
                ? '地块不匹配（可能为多格作物，需 2x2 主格）'
                : `种植失败(${result.failedErrorCodes.join(',')})`;
            unplantableSeeds.set(seed.seedId, { reason, at: Date.now(), codes: result.failedErrorCodes });
            logWarn('种植', `种子 ${seed.name} 全部种植失败（${reason}），已学习跳过，允许第二优先策略补种`, {
                module: 'farm',
                event: '种植种子',
                result: 'all_failed_learned',
                seedId: seed.seedId,
                codes: result.failedErrorCodes,
            });
            continue;
        }

        if (result.planted < plannedPlantCount && remainingLandIds.length > 0) {
            fallbackAllowed = false;
            logWarn('种植', `背包种子 ${seed.name} 实际种植 ${result.planted}/${plannedPlantCount}，为避免误购商店种子，本轮不执行第二优先策略`, {
                module: 'farm',
                event: '种植种子',
                result: 'partial_bag_failure',
                seedId: seed.seedId,
                requested: plannedPlantCount,
                planted: result.planted,
            });
        }
    }

    if (usedSeedLogs.length > 0) {
        log('种植', `已按背包优先策略种植: ${usedSeedLogs.join('，')}`, {
            module: 'farm',
            event: '种植种子',
            result: 'ok',
            strategy: 'bag_priority',
            count: totalPlanted,
        });
    }

    return {
        remainingLandIds,
        fallbackAllowed,
        plantedLandIds: [...new Set(plantedLandIds)],
        totalPlanted,
        occupiedCount,
    };
}

async function findBestSeed(overrideStrategy?: unknown): Promise<DynamicRecord | null> {
    const SEED_SHOP_ID = 2;
    const shopReply = await getShopInfo(SEED_SHOP_ID);
    if (!shopReply.goods_list || shopReply.goods_list.length === 0) {
        logWarn('商店', '种子商店无商品');
        return null;
    }

    const state = getUserState();
    const available: DynamicRecord[] = [];
    for (const goods of shopReply.goods_list) {
        if (!goods.unlocked) continue;

        let meetsConditions = true;
        let requiredLevel = 0;
        const conds = goods.conds || [];
        for (const cond of conds) {
            if (toNum(cond.type) === 1) {
                requiredLevel = toNum(cond.param);
                if (state.level < requiredLevel) {
                    meetsConditions = false;
                    break;
                }
            }
        }
        if (!meetsConditions) continue;

        const limitCount = toNum(goods.limit_count);
        const boughtNum = toNum(goods.bought_num);
        if (limitCount > 0 && boughtNum >= limitCount) continue;

        available.push({
            goods,
            goodsId: toNum(goods.id),
            seedId: toNum(goods.item_id),
            price: toNum(goods.price),
            requiredLevel,
        });
    }

    if (available.length === 0) {
        logWarn('商店', '没有可购买的种子');
        return null;
    }

    // 按策略排序
    const strategy = overrideStrategy || getPlantingStrategy();
    const analyticsSortByMap = {
        max_exp: 'exp',
        max_fert_exp: 'fert',
        max_profit: 'profit',
        max_fert_profit: 'fert_profit',
    };
    const analyticsSortBy = analyticsSortByMap[strategy as keyof typeof analyticsSortByMap];
    if (analyticsSortBy) {
        try {
            const rankings = getPlantRankings(analyticsSortBy);
            const availableBySeedId = new Map<number, DynamicRecord>(available.map((seed) => [seed.seedId, seed]));
            for (const row of rankings) {
                const seedId = Number(row && row.seedId) || 0;
                if (seedId <= 0) continue;
                const lv = Number(row && row.level);
                if (Number.isFinite(lv) && lv > state.level) continue;
                const found = availableBySeedId.get(seedId);
                if (found) return found;
            }
            logWarn('商店', `策略 ${strategy} 未找到可购买作物，回退最高等级`);
        } catch (e) {
            logWarn('商店', `策略 ${strategy} 计算失败: ${errorMessage(e)}，回退最高等级`);
        }
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
        return available[0];
    }

    // 偏好模式
    if (strategy === 'preferred') {
        const preferred = getPreferredSeed();
        if (preferred > 0) {
            const found = available.find(a => a.seedId === preferred);
            if (found) return found;
            logWarn('商店', `优先种子 ${preferred} 当前不可购买，回退自动选择`);
        }
        // 如果偏好未找到或未设置，回退到默认（等级最高）
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
    }
    // 最高等级模式
    else if (strategy === 'level') {
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
    }
    // 默认
    else {
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
    }

    return available[0];
}

async function getAvailableSeeds(): Promise<DynamicRecord[]> {
    const SEED_SHOP_ID = 2;
    const state = getUserState();
    let list: DynamicRecord[] = [];

    try {
        const shopReply = await getShopInfo(SEED_SHOP_ID);
        if (shopReply.goods_list) {
            for (const goods of shopReply.goods_list) {
                // 不再过滤不可用的种子，而是返回给前端展示状态
                let requiredLevel = 0;
                for (const cond of goods.conds || []) {
                    if (toNum(cond.type) === 1) requiredLevel = toNum(cond.param);
                }

                const limitCount = toNum(goods.limit_count);
                const boughtNum = toNum(goods.bought_num);
                const isSoldOut = limitCount > 0 && boughtNum >= limitCount;

                list.push({
                    seedId: toNum(goods.item_id),
                    goodsId: toNum(goods.id),
                    name: getPlantNameBySeedId(toNum(goods.item_id)),
                    price: toNum(goods.price),
                    requiredLevel,
                    locked: !goods.unlocked || state.level < requiredLevel,
                    soldOut: isSoldOut,
                });
            }
        }
    } catch (e) {
        const wsErr = getWsErrorState();
        if (!wsErr || Number(wsErr.code) !== 400) {
            logWarn('商店', `获取商店失败: ${errorMessage(e)}，使用本地备选列表`);
        }
    }

    // 如果商店请求失败或为空，使用本地配置
    if (list.length === 0) {
        const allSeeds = getAllSeeds();
        list = allSeeds.map((seed: DynamicRecord) => ({
            ...seed,
            goodsId: 0,
            price: null, // 未知价格
            requiredLevel: null, // 未知等级
            unknownMeta: true,
            locked: false,
            soldOut: false,
        }));
    }
    return list.sort((a: DynamicRecord, b: DynamicRecord) => {
        const av = (a.requiredLevel === null || a.requiredLevel === undefined) ? 9999 : a.requiredLevel;
        const bv = (b.requiredLevel === null || b.requiredLevel === undefined) ? 9999 : b.requiredLevel;
        return av - bv;
    });
}

async function plantFromShop(
    landsToPlant: number[],
    state: DynamicRecord,
    overrideStrategy?: unknown,
): Promise<DynamicRecord> {
    // 2. 查询种子商店
    let bestSeed;
    try {
        bestSeed = await findBestSeed(overrideStrategy);
    } catch (e) {
        logWarn('商店', `查询失败: ${errorMessage(e)}`);
        return { plantedLands: [] };
    }
    if (!bestSeed) return { plantedLands: [] };

    const seedName = getPlantNameBySeedId(bestSeed.seedId);
    const growTime = getPlantGrowTime(1020000 + (bestSeed.seedId - 20000));  // 转换为植物ID
    const growTimeStr = growTime > 0 ? ` 生长${formatGrowTime(growTime)}` : '';
    const plantSize = getPlantSizeBySeedId(bestSeed.seedId);

    // 失败学习：该种子此前整轮种植失败（如 2x2 种子配置缺失被种到 1x1 地块），TTL 内跳过，避免反复购买浪费金币
    const learned = unplantableSeeds.get(bestSeed.seedId);
    if (learned && Date.now() - learned.at < UNPLANTABLE_LEARN_TTL) {
        log('商店', `种子 ${seedName} 种植失败过（${learned.reason}），本轮跳过`, {
            module: 'farm', event: '购买种子跳过', result: 'learned_skip', seedId: bestSeed.seedId,
        });
        return { plantedLands: [] };
    }
    const landFootprint = plantSize * plantSize;
    log('商店', `最佳种子: ${seedName} (${bestSeed.seedId}) 价格=${bestSeed.price}金币${growTimeStr}`, {
        module: 'warehouse', event: '选择种子', seedId: bestSeed.seedId, price: bestSeed.price
    });

    // 3. 购买
    let needCount = landsToPlant.length;
    const targetLands = landsToPlant;
    let quadGroups = null;
    if (landFootprint > 1) {
        // 2x2 作物：从当前空地选择不重叠组合，并提交每组左下主格，避免主格错位（1001052）。
        quadGroups = findEmptyLandQuads(landsToPlant);
        if (quadGroups.length === 0) {
            log('种植', `${seedName} 为 ${plantSize}x${plantSize} 作物，当前空地无法组成 2x2，本轮跳过`, {
                module: 'farm',
                event: '种植种子',
                result: 'no_2x2_quads',
                seedId: bestSeed.seedId,
                landFootprint,
                emptyCount: landsToPlant.length,
            });
            return { plantedLands: [] };
        }
        needCount = quadGroups.length;
        log('种植', `${seedName} 为 ${plantSize}x${plantSize} 作物，空地自动整合 ${needCount} 组（每组 4 格）`, {
            module: 'farm',
            event: '种植种子',
            result: 'auto_quad',
            seedId: bestSeed.seedId,
            landFootprint,
            quads: needCount,
        });
        if (needCount <= 0) {
            log('种植', `${seedName} 需要至少 ${landFootprint} 块空地才能合并种植，当前仅 ${landsToPlant.length} 块可用，已跳过`, {
                module: 'farm',
                event: '种植种子',
                result: 'skip',
                seedId: bestSeed.seedId,
                landFootprint,
                emptyCount: landsToPlant.length,
            });
            return { plantedLands: [] };
        }
    }
    const totalCost = bestSeed.price * needCount;
    if (totalCost > state.gold) {
        logWarn('商店', `金币不足! 需要 ${totalCost} 金币, 当前 ${state.gold} 金币`, {
            module: 'farm', event: '购买种子跳过', result: 'insufficient_gold', need: totalCost, current: state.gold
        });
        const canBuy = Math.floor(state.gold / bestSeed.price);
        if (canBuy <= 0) return { plantedLands: [] };
        // 2x2 时按当前可用组合数限制购买量，避免买超后无法种植。
        needCount = Math.min(canBuy, quadGroups ? quadGroups.length : targetLands.length);
        log('商店', plantSize > 1 ? `金币有限，只尝试种植 ${needCount} 组 ${plantSize}x${plantSize} 作物` : `金币有限，只种 ${needCount} 块地`);
    }


    let actualSeedId = bestSeed.seedId;
    try {
        const buyReply = await buyGoods(bestSeed.goodsId, needCount, bestSeed.price);
        if (buyReply.get_items && buyReply.get_items.length > 0) {
            const gotItem = buyReply.get_items[0];
            const gotId = toNum(gotItem.id);
            if (gotId > 0) actualSeedId = gotId;
        }
        if (buyReply.cost_items) {
            for (const item of buyReply.cost_items) {
                state.gold -= toNum(item.count);
            }
        }
        const boughtName = getPlantNameBySeedId(actualSeedId);
        //log('购买', `已购买 ${boughtName}种子 x${landsToPlant.length}, 花费 ${bestSeed.price * landsToPlant.length} 金币`, {
        log('购买', `已购买 ${boughtName}种子 x${needCount}, 花费 ${bestSeed.price * needCount} 金币`, {
            module: 'warehouse',
            event: '购买种子',
            result: 'ok',
            seedId: actualSeedId,
            // count: landsToPlant.length,
            // cost: bestSeed.price * landsToPlant.length,
            count: needCount,
            cost: bestSeed.price * needCount,
        });
    } catch (e) {
        logWarn('购买', errorMessage(e));
        return { plantedLands: [] };
    }

    // 4. 种植（逐块拖动，间隔50ms；2x2 作物每组只提交主格，由服务端自动整合）
    let plantedLands: number[] = [];
    try {
        const { planted, plantedLandIds, occupiedLandIds, failedErrorCodes } = await plantSeeds(actualSeedId, targetLands, quadGroups
            ? { quadGroups, maxPlantCount: needCount }
            : { maxPlantCount: needCount });
        // 失败学习：1001052（地块不匹配，可能为 2x2 种子配置缺失）→ 记录，与背包路径共享 unplantableSeeds，
        // 后续轮次按 2x2 主格处理/跳过，避免反复购买浪费金币
        if (Array.isArray(failedErrorCodes) && failedErrorCodes.includes('1001052')) {
            unplantableSeeds.set(actualSeedId, { reason: '地块不匹配（可能为多格作物，需 2x2 主格）', at: Date.now(), codes: failedErrorCodes });
        }
        const occupiedCount = occupiedLandIds.length > 0 ? occupiedLandIds.length : planted;
        log('种植', plantSize > 1
            ? `已种植 ${planted} 组 ${plantSize}x${plantSize} 作物，占用 ${occupiedCount} 块地 (${occupiedLandIds.join(',')})`
            : `已在 ${planted} 块地种植 (${landsToPlant.slice(0, planted).join(',')})`, {
            module: 'farm',
            event: '种植种子',
            result: 'ok',
            seedId: actualSeedId,
            count: planted,
            occupiedCount,
        });
        if (planted > 0) {
            plantedLands = plantedLandIds;
        }
    } catch (e) {
        logWarn('种植', errorMessage(e));
    }

    return { plantedLands };
}

export {
    encodePlantRequest,
    findBestSeed,
    getAvailableSeeds,
    getPlantingStrategyLabel,
    plantFromBagSeeds,
    plantFromShop,
    plantSeeds,
    sortBagSeedsForPlanting,
};
