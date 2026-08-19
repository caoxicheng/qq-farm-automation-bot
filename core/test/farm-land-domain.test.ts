const assert = require('node:assert/strict');
const test = require('node:test');
const {
    analyzeLands,
    buildLandMap,
    buildSlaveToMasterMap,
    classifyHarvestedLandsByMap,
    filterLandIdsByTypes,
    findEmptyLandQuads,
    getDisplayLandContext,
    getLandLifecycleState,
    getLandTypeByLevel,
    normalizeFertilizerLandTypes,
} = require('../src/services/farm-land-domain');

function phase(value) {
    return { phase: value, begin_time: 1 };
}

test('四格作物全空时选择六组标准分区并将左下主格放在首位', () => {
    assert.deepEqual(findEmptyLandQuads(Array.from({ length: 24 }, (_, index) => index + 1)), [
        [5, 1, 2, 6],
        [7, 3, 4, 8],
        [13, 9, 10, 14],
        [15, 11, 12, 16],
        [21, 17, 18, 22],
        [23, 19, 20, 24],
    ]);
});

test('四格作物在部分占用时选择最多的不重叠偏移组合', () => {
    assert.deepEqual(findEmptyLandQuads([7, 8, 11, 12]), [[11, 7, 8, 12]]);
    assert.deepEqual(findEmptyLandQuads([2, 3, 6, 7]), [[6, 2, 3, 7]]);
    const emptyExceptOneAndFour = Array.from({ length: 24 }, (_, index) => index + 1)
        .filter(landId => landId !== 1 && landId !== 4);
    assert.deepEqual(findEmptyLandQuads(emptyExceptOneAndFour), [
        [6, 2, 3, 7],
        [13, 9, 10, 14],
        [15, 11, 12, 16],
        [21, 17, 18, 22],
        [23, 19, 20, 24],
    ]);
    assert.deepEqual(findEmptyLandQuads([16, 17, 18]), []);
});

test('主从土地拓扑将从地映射到有作物的主地', () => {
    const master = {
        id: 5,
        slave_land_ids: [1, 2, 6],
        plant: { phases: [phase(4)] },
    };
    const slave = { id: 1, master_land_id: 5 };
    const lands = [slave, master];
    const landsMap = buildLandMap(lands);

    assert.deepEqual([...buildSlaveToMasterMap(lands).entries()], [[1, 5], [2, 5], [6, 5]]);
    assert.deepEqual(getDisplayLandContext(slave, landsMap), {
        sourceLand: master,
        occupiedByMaster: true,
        masterLandId: 5,
        occupiedLandIds: [5, 1, 2, 6],
    });
});

test('土地类型规范化去重并按选择范围过滤', () => {
    assert.deepEqual(normalizeFertilizerLandTypes(['RED', 'gold', 'red', 'invalid']), ['red', 'gold']);
    assert.equal(getLandTypeByLevel(1), 'normal');
    assert.equal(getLandTypeByLevel(2), 'red');
    assert.equal(getLandTypeByLevel(3), 'black');
    assert.equal(getLandTypeByLevel(4), 'gold');

    const typesById = new Map([[1, 'normal'], [2, 'red'], [3, 'gold']]);
    assert.deepEqual(filterLandIdsByTypes([1, 2, 3], typesById, ['red', 'gold']), [2, 3]);
    assert.deepEqual(filterLandIdsByTypes([1, 2, 3], typesById, []), []);
});

test('收获后土地按空地、枯死、生长和未知状态分类', () => {
    const lands = [
        { id: 1 },
        { id: 2, plant: { phases: [phase(7)] } },
        { id: 3, plant: { phases: [phase(4)] } },
    ];
    const landsMap = buildLandMap(lands);

    assert.equal(getLandLifecycleState(lands[0]), 'empty');
    assert.equal(getLandLifecycleState(lands[1]), 'dead');
    assert.equal(getLandLifecycleState(lands[2]), 'growing');
    assert.deepEqual(classifyHarvestedLandsByMap([1, 2, 3, 4], landsMap), {
        removable: [1, 2],
        growing: [3],
        unknown: [4],
    });
});

test('农田分析汇总成熟、空地、枯死和帮助操作', () => {
    const result = analyzeLands([
        { id: 1, unlocked: true, plant: { id: 20001, name: '成熟作物', phases: [phase(6)] } },
        { id: 2, unlocked: true },
        { id: 3, unlocked: true, plant: { id: 20003, phases: [phase(7)] } },
        {
            id: 4,
            unlocked: true,
            plant: {
                id: 20004,
                phases: [phase(4)],
                dry_num: 1,
                weed_owners: [8],
                insect_owners: [9],
            },
        },
        { id: 5, unlocked: false, could_unlock: true },
    ]);

    assert.deepEqual(result.harvestable, [1]);
    assert.deepEqual(result.empty, [2]);
    assert.deepEqual(result.dead, [3]);
    assert.deepEqual(result.growing, [4]);
    assert.deepEqual(result.needWater, [4]);
    assert.deepEqual(result.needWeed, [4]);
    assert.deepEqual(result.needBug, [4]);
    assert.deepEqual(result.unlockable, [5]);
});

export {};
