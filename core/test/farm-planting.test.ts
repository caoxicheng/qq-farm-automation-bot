const assert = require('node:assert/strict');
const test = require('node:test');
const protobuf = require('protobufjs');
const { getPlantSizeBySeedId } = require('../src/config/gameConfig');
const {
    encodePlantRequest,
    getPlantingStrategyLabel,
    sortBagSeedsForPlanting,
} = require('../src/services/farm-planting');

function decodePlantRequest(buffer) {
    const outer = protobuf.Reader.create(buffer);
    assert.equal(outer.uint32(), 18);
    const item = protobuf.Reader.create(outer.bytes());
    assert.equal(item.uint32(), 8);
    const seedId = item.int64().toNumber();
    assert.equal(item.uint32(), 18);
    const packedIds = protobuf.Reader.create(item.bytes());
    const landIds = [];
    while (packedIds.pos < packedIds.len) landIds.push(packedIds.int64().toNumber());
    let autoSlave = false;
    if (item.pos < item.len) {
        assert.equal(item.uint32(), 24);
        autoSlave = item.bool();
    }
    assert.equal(item.pos, item.len);
    assert.equal(outer.pos, outer.len);
    return { seedId, landIds, autoSlave };
}

test('背包种子优先级覆盖等级排序，其余种子按等级与 ID 排序', () => {
    const seeds = [
        { seedId: 10, requiredLevel: 5 },
        { seedId: 20, requiredLevel: 9 },
        { seedId: 30, requiredLevel: 1 },
        { seedId: 40, requiredLevel: 9 },
    ];

    const sorted = sortBagSeedsForPlanting(seeds, [30, 10]);

    assert.deepEqual(sorted.map(seed => seed.seedId), [30, 10, 20, 40]);
    assert.deepEqual(seeds.map(seed => seed.seedId), [10, 20, 30, 40]);
});

test('种植策略展示名兼容内置策略和未知策略', () => {
    assert.equal(getPlantingStrategyLabel('bag_priority'), '背包种子优先');
    assert.equal(getPlantingStrategyLabel('max_fert_profit'), '最大普通肥净利润/时');
    assert.equal(getPlantingStrategyLabel('custom_strategy'), 'custom_strategy');
});

test('活动多格种子在旧版植物表缺失时仍能识别占地尺寸', () => {
    assert.equal(getPlantSizeBySeedId(29003), 2);
    assert.equal(getPlantSizeBySeedId(29003, 1), 2);
    assert.equal(getPlantSizeBySeedId(29999, 1), 1);
});

test('种植请求按协议编码种子、地块和多格自动整合标记', () => {
    assert.deepEqual(decodePlantRequest(encodePlantRequest(20001, [1, 2])), {
        seedId: 20001,
        landIds: [1, 2],
        autoSlave: false,
    });
    assert.deepEqual(decodePlantRequest(encodePlantRequest(29003, [1, 2, 5, 6], true)), {
        seedId: 29003,
        landIds: [1, 2, 5, 6],
        autoSlave: true,
    });
});

export {};
