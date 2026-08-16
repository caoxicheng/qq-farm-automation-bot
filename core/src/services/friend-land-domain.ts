const { PHASE_NAMES, PlantPhase } = require('../config/config');
const {
    deriveSeedIdFromPlantId,
    getPlantById,
    getPlantGrowTime,
    getPlantName,
    getSeedImageBySeedId,
} = require('../config/gameConfig');
const { getServerTimeSec, toNum, toTimeSec } = require('../utils/utils');
const {
    buildLandMap,
    getCurrentPhase,
    getDisplayLandContext,
    isOccupiedSlaveLand,
} = require('./farm-land-domain');

type DynamicRecord = Record<string, any>;

export function analyzeFriendLands(
    lands: DynamicRecord[],
    myGid: unknown,
    friendName = '',
    options: { plantBlacklist?: unknown[] | null } = {},
): DynamicRecord {
    const result: DynamicRecord = {
        stealable: [],
        stealableInfo: [],
        needWater: [],
        needWeed: [],
        needBug: [],
        canPutWeed: [],
        canPutBug: [],
    };
    const landsMap = buildLandMap(lands);
    const plantBlacklist = options.plantBlacklist || null;

    for (const land of lands) {
        const id = toNum(land.id);
        if (isOccupiedSlaveLand(land, landsMap)) continue;
        const plant = land.plant;
        if (!plant?.phases?.length) continue;

        const currentPhase = getCurrentPhase(plant.phases, false, `[${friendName}]土地#${id}`);
        if (!currentPhase) continue;
        const phase = currentPhase.phase;

        if (phase === PlantPhase.MATURE) {
            if (plant.stealable) {
                const plantId = toNum(plant.id);
                const plantName = getPlantName(plantId) || plant.name || '未知';
                const plantConfig = getPlantById(plantId);
                const seedId = toNum(plantConfig?.seed_id) || deriveSeedIdFromPlantId(plantId);
                if (plantBlacklist && seedId > 0 && plantBlacklist.includes(seedId)) continue;
                result.stealable.push(id);
                result.stealableInfo.push({ landId: id, plantId, name: plantName });
            }
            continue;
        }
        if (phase === PlantPhase.DEAD) continue;

        if (toNum(plant.dry_num) > 0) result.needWater.push(id);
        if (plant.weed_owners?.length > 0) result.needWeed.push(id);
        if (plant.insect_owners?.length > 0) result.needBug.push(id);

        const weedOwners = plant.weed_owners || [];
        const insectOwners = plant.insect_owners || [];
        const alreadyPutWeed = weedOwners.some((gid: unknown) => toNum(gid) === myGid);
        const alreadyPutBug = insectOwners.some((gid: unknown) => toNum(gid) === myGid);
        if (weedOwners.length < 2 && !alreadyPutWeed) result.canPutWeed.push(id);
        if (insectOwners.length < 2 && !alreadyPutBug) result.canPutBug.push(id);
    }
    return result;
}

export function buildFriendLandsDetail(lands: DynamicRecord[]): DynamicRecord[] {
    const result: DynamicRecord[] = [];
    const nowSec = getServerTimeSec();
    const landsMap = buildLandMap(lands);
    for (const land of lands) {
        const id = toNum(land.id);
        const level = toNum(land.level);
        const unlocked = !!land.unlocked;
        const {
            sourceLand,
            occupiedByMaster,
            masterLandId,
            occupiedLandIds,
        } = getDisplayLandContext(land, landsMap);
        if (!unlocked) {
            result.push({
                id,
                unlocked: false,
                status: 'locked',
                plantName: '',
                phaseName: '未解锁',
                level,
                needWater: false,
                needWeed: false,
                needBug: false,
                occupiedByMaster: false,
                masterLandId: 0,
                occupiedLandIds: [],
                plantSize: 1,
            });
            continue;
        }
        const plant = sourceLand?.plant;
        if (!plant?.phases?.length) {
            result.push({
                id,
                unlocked: true,
                status: 'empty',
                plantName: '',
                phaseName: '空地',
                level,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
                plantSize: 1,
            });
            continue;
        }
        const currentPhase = getCurrentPhase(plant.phases, false, '');
        if (!currentPhase) {
            result.push({
                id,
                unlocked: true,
                status: 'empty',
                plantName: '',
                phaseName: '',
                level,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
                plantSize: 1,
            });
            continue;
        }

        const phase = currentPhase.phase;
        const plantId = toNum(plant.id);
        const plantName = getPlantName(plantId) || plant.name || '未知';
        const plantConfig = getPlantById(plantId);
        const seedId = toNum(plantConfig?.seed_id) || deriveSeedIdFromPlantId(plantId);
        const maturePhase = plant.phases.find((item: DynamicRecord) => toNum(item?.phase) === PlantPhase.MATURE);
        const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
        let status = 'growing';
        if (phase === PlantPhase.MATURE) status = plant.stealable ? 'stealable' : 'harvested';
        else if (phase === PlantPhase.DEAD) status = 'dead';

        result.push({
            id,
            unlocked: true,
            status,
            plantName,
            seedId,
            seedImage: seedId > 0 ? getSeedImageBySeedId(seedId) : '',
            phaseName: PHASE_NAMES[phase] || '',
            currentSeason: Math.max(1, Math.min(toNum(plant.season) || 1, Math.max(1, toNum(plantConfig?.seasons) || 1))),
            totalSeason: Math.max(1, toNum(plantConfig?.seasons) || 1),
            level,
            matureInSec: matureBegin > nowSec ? matureBegin - nowSec : 0,
            totalGrowTime: getPlantGrowTime(plantId),
            needWater: toNum(plant.dry_num) > 0,
            needWeed: plant.weed_owners?.length > 0,
            needBug: plant.insect_owners?.length > 0,
            occupiedByMaster,
            masterLandId,
            occupiedLandIds,
            plantSize: Math.max(1, toNum(plantConfig?.size) || 1),
        });
    }
    return result;
}
