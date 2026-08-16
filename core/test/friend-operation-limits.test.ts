const assert = require('node:assert/strict');
const test = require('node:test');
const { createFriendOperationLimitTracker } = require('../src/services/friend-operation-limits');

function createHarness(initialDate = '2026-08-15') {
    let dateKey = initialDate;
    const persistedDates = [];
    const stoppedDates = new Set();
    const logs = [];
    const tracker = createFriendOperationLimitTracker({
        getDateKey: () => dateKey,
        loadBadDailyStop: date => stoppedDates.has(date),
        persistBadDailyStop: (date) => {
            stoppedDates.add(date);
            persistedDates.push(date);
        },
        log: (tag, message, meta) => logs.push({ tag, message, meta }),
    });
    return {
        logs,
        persistedDates,
        stoppedDates,
        tracker,
        setDate(nextDate) { dateKey = nextDate; },
    };
}

test('好友操作额度统一计算剩余次数和经验可用性', () => {
    const { tracker } = createHarness();
    tracker.updateOperationLimits([
        {
            id: 10007,
            day_times: 2,
            day_times_lt: 5,
            day_exp_times: 1,
            day_ex_times_lt: 2,
        },
        {
            id: 10008,
            day_times: 3,
            day_times_lt: 3,
            day_exp_times: 0,
            day_ex_times_lt: 0,
        },
    ]);

    assert.equal(tracker.canOperate(10007), true);
    assert.equal(tracker.canOperate(10008), false);
    assert.equal(tracker.canGetExpByCandidates([10007]), true);
    assert.equal(tracker.canGetExpByCandidates([99999]), false);
    assert.deepEqual(tracker.getOperationLimits()[10007], {
        name: '浇水',
        dayTimes: 2,
        dayTimesLimit: 5,
        dayExpTimes: 1,
        dayExpTimesLimit: 2,
        remaining: 3,
    });
});

test('捣乱共享额度满额后持久化且同一天保持停用', () => {
    const { persistedDates, tracker } = createHarness();
    tracker.updateOperationLimits([{
        id: 10003,
        day_times: 10,
        day_times_lt: 10,
        day_exp_times: 0,
        day_ex_times_lt: 0,
    }]);

    assert.equal(tracker.isBadOperationLimitReached(), true);
    assert.equal(tracker.getRemainingBadOperationTimes(), 0);
    assert.deepEqual(persistedDates, ['2026-08-15']);
    assert.equal(tracker.markBadOperationLimitReached('PutInsects'), false);
    assert.deepEqual(persistedDates, ['2026-08-15']);
});

test('跨日会清空旧额度并恢复帮助经验状态', () => {
    const harness = createHarness();
    const { tracker } = harness;
    tracker.updateOperationLimits([{
        id: 10008,
        day_times: 1,
        day_times_lt: 1,
        day_exp_times: 1,
        day_ex_times_lt: 1,
    }]);
    tracker.autoDisableHelpByExpLimit();
    assert.equal(tracker.isHelpExpLimitReached(), true);
    assert.equal(tracker.canOperate(10008), false);

    harness.setDate('2026-08-16');
    tracker.checkDailyReset();

    assert.equal(tracker.isHelpExpLimitReached(), false);
    assert.equal(tracker.canGetHelpExperience(), true);
    assert.equal(tracker.canOperate(10008), true);
    assert.deepEqual(tracker.getOperationLimits(), {});
});

test('重启后会恢复当天已持久化的捣乱停用状态', () => {
    const harness = createHarness();
    harness.stoppedDates.add('2026-08-15');

    harness.tracker.checkDailyReset();

    assert.equal(harness.tracker.isBadOperationLimitReached(), true);
    assert.equal(harness.tracker.getRemainingBadOperationTimes(), 0);
});

export {};
