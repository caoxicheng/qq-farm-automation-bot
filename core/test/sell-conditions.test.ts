import assert from 'node:assert/strict';
// eslint-disable-next-line test/no-import-node-test -- 项目测试由 Node 内置测试运行器执行
import test from 'node:test';
import { areSellConditionsKnown, isSellConditionSatisfied, parseSellConditions } from '../src/config/sell-conditions';
import { decodeActivityWindows } from '../src/services/activity-windows';
import { getSellEligibility } from '../src/services/warehouse';

const qingMeiWindow = {
    id: '2026081202',
    name: '青酿换万金',
    beginTime: 1786464000,
    endTime: 1786895999,
};

const conditionalPriceWindow = {
    id: '2026030202',
    name: '条件售价活动',
    beginTime: 1_770_000_000,
    endTime: 1_770_086_399,
};

function context(nowSec: number, loaded = true) {
    return {
        nowSec,
        activityWindowsLoaded: loaded,
        activityWindows: new Map([[qingMeiWindow.id, qingMeiWindow]]),
    };
}

function conditionalPriceContext(nowSec: number, loaded = true) {
    return {
        nowSec,
        activityWindowsLoaded: loaded,
        activityWindows: new Map([[conditionalPriceWindow.id, conditionalPriceWindow]]),
    };
}

test('出售条件支持活动边界与多条件组合', () => {
    assert.deepEqual(parseSellConditions('活动区间外:2026081202; 道具过期后:expire_time'), [
        { type: '活动区间外', value: '2026081202' },
        { type: '道具过期后', value: 'expire_time' },
    ]);
    assert.equal(isSellConditionSatisfied('活动区间外:2026081202', context(qingMeiWindow.endTime)), false);
    assert.equal(isSellConditionSatisfied('活动区间外:2026081202', context(qingMeiWindow.endTime + 1)), true);
    assert.equal(isSellConditionSatisfied('活动结束后:2026081202', context(qingMeiWindow.endTime)), true);
    assert.equal(isSellConditionSatisfied('活动结束后:2026081202', context(qingMeiWindow.endTime, false)), false);
    assert.equal(areSellConditionsKnown('活动结束后:2026081202', context(qingMeiWindow.endTime, false)), false);
    assert.equal(isSellConditionSatisfied('道具过期后:expire_time', {
        ...context(100),
        expireTime: 100,
    }), true);
});

test('活动窗口未知时不展示或放行条件售价', () => {
    const unknownContext = conditionalPriceContext(conditionalPriceWindow.endTime + 1, false);
    const unknown = getSellEligibility({ id: 49001, count: 1, uid: '101' }, unknownContext);
    assert.equal(unknown.sellable, false);
    assert.deepEqual(unknown.rewards, []);

    const beforeEnd = getSellEligibility(
        { id: 49001, count: 1, uid: '101' },
        conditionalPriceContext(conditionalPriceWindow.beginTime),
    );
    assert.equal(beforeEnd.sellable, true);
    assert.deepEqual(beforeEnd.rewards.map(reward => reward.id), [1017]);

    const afterEnd = getSellEligibility(
        { id: 49001, count: 1, uid: '101' },
        conditionalPriceContext(conditionalPriceWindow.endTime + 1),
    );
    assert.equal(afterEnd.sellable, true);
    assert.deepEqual(afterEnd.rewards.map(reward => reward.id), [1001]);
});

test('活动列表回包转换为可查询的时间窗口', () => {
    const windows = decodeActivityWindows({
        activity_windows: [{ id: 2026081202, name: '青酿换万金', begin_time: 1_780_000_000_000, end_time: 1_780_000_010_000 }],
    });
    assert.deepEqual(windows.get('2026081202'), {
        id: '2026081202',
        name: '青酿换万金',
        beginTime: 1_780_000_000,
        endTime: 1_780_000_010,
    });
});
