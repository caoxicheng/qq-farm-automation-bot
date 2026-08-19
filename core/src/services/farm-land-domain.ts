const { PHASE_NAMES, PlantPhase } = require('../config/config');
const { getPlantExp, getPlantName } = require('../config/gameConfig');
const { getServerTimeSec, toNum, toTimeSec } = require('../utils/utils');

type DynamicRecord = Record<string, any>;
export type LandType = 'gold' | 'black' | 'red' | 'normal';

export const ALL_FERTILIZER_LAND_TYPES: LandType[] = ['gold', 'black', 'red', 'normal'];
const FERTILIZER_LAND_TYPE_LABELS: Record<LandType, string> = {
    gold: '金土地',
    black: '黑土地',
    red: '红土地',
    normal: '普通土地',
};

export function getCurrentPhase(
    phases: DynamicRecord[],
    debug = false,
    landLabel = '',
): DynamicRecord | null {
    if (!Array.isArray(phases) || phases.length === 0) return null;
    const nowSec = getServerTimeSec();
    if (debug) {
        console.warn(`    ${landLabel} 服务器时间=${nowSec} (${new Date(nowSec * 1000).toLocaleTimeString()})`);
        for (let index = 0; index < phases.length; index += 1) {
            const phase = phases[index];
            const beginTime = toTimeSec(phase.begin_time);
            const phaseName = PHASE_NAMES[phase.phase] || `阶段${phase.phase}`;
            const diff = beginTime > 0 ? beginTime - nowSec : 0;
            const diffText = diff > 0 ? `(未来 ${diff}s)` : diff < 0 ? `(已过 ${-diff}s)` : '';
            console.warn(`    ${landLabel}   [${index}] ${phaseName}(${phase.phase}) begin=${beginTime} ${diffText} dry=${toTimeSec(phase.dry_time)} weed=${toTimeSec(phase.weeds_time)} insect=${toTimeSec(phase.insect_time)}`);
        }
    }
    for (let index = phases.length - 1; index >= 0; index -= 1) {
        const beginTime = toTimeSec(phases[index].begin_time);
        if (beginTime <= 0 || beginTime > nowSec) continue;
        if (debug) console.warn(`    ${landLabel}   → 当前阶段: ${PHASE_NAMES[phases[index].phase] || phases[index].phase}`);
        return phases[index];
    }
    if (debug) console.warn(`    ${landLabel}   → 所有阶段都在未来，使用第一个: ${PHASE_NAMES[phases[0].phase] || phases[0].phase}`);
    return phases[0];
}

export function getOrganicFertilizerTargetsFromLands(lands: DynamicRecord[]): number[] {
    const targets: number[] = [];
    for (const land of (Array.isArray(lands) ? lands : [])) {
        if (!land?.unlocked) continue;
        const landId = toNum(land.id);
        const plant = land.plant;
        if (!landId || !plant?.phases?.length) continue;
        const phase = getCurrentPhase(plant.phases)?.phase;
        if (phase === undefined || phase === PlantPhase.DEAD) continue;
        if (Object.hasOwn(plant, 'left_inorc_fert_times') && toNum(plant.left_inorc_fert_times) <= 0) continue;
        targets.push(landId);
    }
    return targets;
}

export function getFastMatureLands(lands: DynamicRecord[], thresholdSec = 300): number[] {
    const targets: number[] = [];
    const nowSec = getServerTimeSec();
    const threshold = Math.max(0, toNum(thresholdSec) || 300);
    for (const land of (Array.isArray(lands) ? lands : [])) {
        if (!land?.unlocked) continue;
        const landId = toNum(land.id);
        const plant = land.plant;
        if (!landId || !plant?.phases?.length) continue;
        const currentPhase = getCurrentPhase(plant.phases)?.phase;
        if (currentPhase === undefined || currentPhase === PlantPhase.DEAD || currentPhase === PlantPhase.MATURE) continue;
        const maturePhase = plant.phases.find((phase: DynamicRecord) => toNum(phase.phase) === PlantPhase.MATURE);
        const timeToMature = maturePhase ? toTimeSec(maturePhase.begin_time) - nowSec : -1;
        if (timeToMature < 0 || timeToMature > threshold) continue;
        if (Object.hasOwn(plant, 'left_inorc_fert_times') && toNum(plant.left_inorc_fert_times) <= 0) continue;
        targets.push(landId);
    }
    return targets;
}

export function getSlaveLandIds(land: DynamicRecord): number[] {
    const ids = Array.isArray(land?.slave_land_ids) ? land.slave_land_ids : [];
    return [...new Set(ids.map((id: unknown) => toNum(id)).filter(Boolean))] as number[];
}

export function findEmptyLandQuads(emptyLandIds: unknown[]): number[][] {
    const emptySet = new Set((emptyLandIds || []).map(Number));
    const candidates: number[][] = [];

    // 土地按每行 4 格编号；服务端要求用 2x2 左下格作为主格，并由 auto_slave 自动占用其余三格。
    for (let topLeft = 1; topLeft <= 20; topLeft += 1) {
        if (topLeft % 4 === 0) continue;
        const occupied = [topLeft, topLeft + 1, topLeft + 4, topLeft + 5];
        if (!occupied.every(landId => emptySet.has(landId))) continue;
        candidates.push([topLeft + 4, ...occupied.filter(landId => landId !== topLeft + 4)]);
    }

    // 最多只有 15 个候选窗口，回溯选出数量最多且互不重叠的组合。
    // 优先尝试编号较小的窗口，保证全空时稳定返回 6 个标准分区。
    let best: number[][] = [];
    const selected: number[][] = [];
    const used = new Set<number>();
    function search(index: number): void {
        if (selected.length + candidates.length - index <= best.length) return;
        if (index >= candidates.length) {
            best = selected.map(group => [...group]);
            return;
        }

        const group = candidates[index];
        if (!group.some(landId => used.has(landId))) {
            selected.push(group);
            group.forEach(landId => used.add(landId));
            search(index + 1);
            group.forEach(landId => used.delete(landId));
            selected.pop();
        }
        search(index + 1);
    }
    search(0);
    return best;
}

function hasPlantData(land: DynamicRecord): boolean {
    return !!land?.plant?.phases?.length;
}

function getLinkedMasterLand(land: DynamicRecord, landsMap: Map<number, DynamicRecord>): DynamicRecord | null {
    const landId = toNum(land?.id);
    const masterLandId = toNum(land?.master_land_id);
    if (!masterLandId || masterLandId === landId) return null;
    const masterLand = landsMap.get(masterLandId);
    if (!masterLand) return null;
    const slaveIds = getSlaveLandIds(masterLand);
    if (slaveIds.length > 0 && !slaveIds.includes(landId)) return null;
    return masterLand;
}

export function getDisplayLandContext(land: DynamicRecord, landsMap: Map<number, DynamicRecord>) {
    const masterLand = getLinkedMasterLand(land, landsMap);
    if (masterLand && hasPlantData(masterLand)) {
        const masterLandId = toNum(masterLand.id);
        const occupiedLandIds = [masterLandId, ...getSlaveLandIds(masterLand)].filter(Boolean);
        return {
            sourceLand: masterLand,
            occupiedByMaster: true,
            masterLandId,
            occupiedLandIds: occupiedLandIds.length > 0 ? occupiedLandIds : [masterLandId].filter(Boolean),
        };
    }
    const selfId = toNum(land?.id);
    return {
        sourceLand: land,
        occupiedByMaster: false,
        masterLandId: selfId,
        occupiedLandIds: [selfId].filter(Boolean),
    };
}

export function isOccupiedSlaveLand(land: DynamicRecord, landsMap: Map<number, DynamicRecord>): boolean {
    return getDisplayLandContext(land, landsMap).occupiedByMaster;
}

export function buildSlaveToMasterMap(lands: DynamicRecord[]): Map<number, number> {
    const result = new Map<number, number>();
    for (const land of (Array.isArray(lands) ? lands : [])) {
        const masterId = toNum(land?.id);
        if (masterId <= 0) continue;
        for (const slaveId of getSlaveLandIds(land)) {
            if (slaveId > 0 && slaveId !== masterId) result.set(slaveId, masterId);
        }
    }
    return result;
}

export function summarizeLandDetails(lands: DynamicRecord[]) {
    const summary = { harvestable: 0, growing: 0, empty: 0, dead: 0, needWater: 0, needWeed: 0, needBug: 0 };
    for (const land of (Array.isArray(lands) ? lands : [])) {
        if (!land?.unlocked) continue;
        const status = String(land.status || '');
        if (status === 'harvestable') summary.harvestable += 1;
        else if (status === 'dead') summary.dead += 1;
        else if (status === 'empty') summary.empty += 1;
        else if (['growing', 'stealable', 'harvested'].includes(status)) summary.growing += 1;
        if (land.needWater) summary.needWater += 1;
        if (land.needWeed) summary.needWeed += 1;
        if (land.needBug) summary.needBug += 1;
    }
    return summary;
}

export function getLandTypeByLevel(level: unknown): LandType {
    const value = toNum(level);
    if (value >= 4) return 'gold';
    if (value === 3) return 'black';
    if (value === 2) return 'red';
    return 'normal';
}

export function normalizeFertilizerLandTypes(input: unknown): LandType[] {
    const source = Array.isArray(input) ? input : ALL_FERTILIZER_LAND_TYPES;
    const result: LandType[] = [];
    for (const item of source) {
        const value = String(item || '').trim().toLowerCase() as LandType;
        if (!ALL_FERTILIZER_LAND_TYPES.includes(value) || result.includes(value)) continue;
        result.push(value);
    }
    return result;
}

export function filterLandIdsByTypes(
    landIds: number[],
    landTypeById: Map<number, LandType>,
    selectedTypes: unknown,
): number[] {
    const ids = Array.isArray(landIds) ? landIds : [];
    const selected = new Set(normalizeFertilizerLandTypes(selectedTypes));
    if (selected.size === 0) return [];
    if (selected.size === ALL_FERTILIZER_LAND_TYPES.length) return [...ids];
    return ids.filter(id => selected.has(landTypeById.get(id) as LandType));
}

export function formatFertilizerLandTypes(types: unknown): string[] {
    return normalizeFertilizerLandTypes(types).map(type => FERTILIZER_LAND_TYPE_LABELS[type]);
}

export function analyzeLands(lands: DynamicRecord[], debug = false): DynamicRecord {
    const result: DynamicRecord = {
        harvestable: [],
        needWater: [],
        needWeed: [],
        needBug: [],
        growing: [],
        empty: [],
        dead: [],
        unlockable: [],
        upgradable: [],
        harvestableInfo: [],
    };
    const nowSec = getServerTimeSec();
    const landsMap = buildLandMap(lands);
    for (const land of lands) {
        const id = toNum(land.id);
        if (!land.unlocked) {
            if (land.could_unlock) result.unlockable.push(id);
            continue;
        }
        if (land.could_upgrade) result.upgradable.push(id);
        if (isOccupiedSlaveLand(land, landsMap)) continue;
        const plant = land.plant;
        if (!plant?.phases?.length) {
            result.empty.push(id);
            continue;
        }
        const name = plant.name || '未知作物';
        const phase = getCurrentPhase(plant.phases, debug, `土地#${id}(${name})`);
        if (!phase) {
            result.empty.push(id);
            continue;
        }
        if (phase.phase === PlantPhase.DEAD) {
            result.dead.push(id);
            continue;
        }
        if (phase.phase === PlantPhase.MATURE) {
            const plantId = toNum(plant.id);
            result.harvestable.push(id);
            result.harvestableInfo.push({
                landId: id,
                plantId,
                name: getPlantName(plantId) || name,
                exp: getPlantExp(plantId),
            });
            continue;
        }
        if (toNum(plant.dry_num) > 0 || (toTimeSec(phase.dry_time) > 0 && toTimeSec(phase.dry_time) <= nowSec)) result.needWater.push(id);
        if (plant.weed_owners?.length > 0 || (toTimeSec(phase.weeds_time) > 0 && toTimeSec(phase.weeds_time) <= nowSec)) result.needWeed.push(id);
        if (plant.insect_owners?.length > 0 || (toTimeSec(phase.insect_time) > 0 && toTimeSec(phase.insect_time) <= nowSec)) result.needBug.push(id);
        result.growing.push(id);
    }
    return result;
}

export function buildLandMap(lands: DynamicRecord[]): Map<number, DynamicRecord> {
    const result = new Map<number, DynamicRecord>();
    for (const land of (Array.isArray(lands) ? lands : [])) {
        const id = toNum(land?.id);
        if (id > 0) result.set(id, land);
    }
    return result;
}

export function getLandLifecycleState(land: DynamicRecord | null | undefined): 'unknown' | 'empty' | 'dead' | 'growing' {
    if (!land) return 'unknown';
    if (!land.plant?.phases?.length) return 'empty';
    const phase = toNum(getCurrentPhase(land.plant.phases)?.phase);
    if (phase === PlantPhase.DEAD) return 'dead';
    if (phase === PlantPhase.UNKNOWN) return 'empty';
    if (phase >= PlantPhase.SEED && phase <= PlantPhase.MATURE) return 'growing';
    return 'unknown';
}

export function classifyHarvestedLandsByMap(landIds: number[], landsMap: Map<number, DynamicRecord>) {
    const removable: number[] = [];
    const growing: number[] = [];
    const unknown: number[] = [];
    for (const id of landIds) {
        const state = getLandLifecycleState(landsMap.get(id));
        if (state === 'dead' || state === 'empty') removable.push(id);
        else if (state === 'growing') growing.push(id);
        else unknown.push(id);
    }
    return { removable, growing, unknown };
}
