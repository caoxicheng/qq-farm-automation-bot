const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeFriendLands, buildFriendLandsDetail } = require('../src/services/friend-land-domain');

function phase(value) {
    return { phase: value, begin_time: 1 };
}

test('好友土地分析区分偷取、帮助和捣乱候选', () => {
    const lands = [
        {
            id: 1,
            unlocked: true,
            plant: {
                id: 20001,
                stealable: true,
                phases: [phase(6)],
                weed_owners: [],
                insect_owners: [],
            },
        },
        {
            id: 2,
            unlocked: true,
            plant: {
                id: 20002,
                phases: [phase(4)],
                dry_num: 1,
                weed_owners: [88],
                insect_owners: [99],
            },
        },
        {
            id: 3,
            unlocked: true,
            plant: { id: 20003, phases: [phase(7)] },
        },
    ];

    const result = analyzeFriendLands(lands, 99, '测试好友');

    assert.deepEqual(result.stealable, [1]);
    assert.deepEqual(result.needWater, [2]);
    assert.deepEqual(result.needWeed, [2]);
    assert.deepEqual(result.needBug, [2]);
    assert.deepEqual(result.canPutWeed, [2]);
    assert.deepEqual(result.canPutBug, []);
});

test('好友土地详情稳定映射锁定、空地和成熟状态', () => {
    const lands = [
        { id: 1, level: 2, unlocked: false },
        { id: 2, level: 3, unlocked: true },
        {
            id: 3,
            level: 4,
            unlocked: true,
            plant: {
                id: 20001,
                stealable: true,
                phases: [phase(6)],
                weed_owners: [],
                insect_owners: [],
            },
        },
    ];

    const result = buildFriendLandsDetail(lands);

    assert.deepEqual(result.map(land => land.status), ['locked', 'empty', 'stealable']);
    assert.equal(result[0].phaseName, '未解锁');
    assert.equal(result[1].phaseName, '空地');
    assert.equal(result[2].phaseName, '成熟');
    assert.equal(result[2].occupiedByMaster, false);
});

export {};
