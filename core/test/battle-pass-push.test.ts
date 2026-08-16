const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { getBattlePassNotifyClaimability, isNoBattlePassRewardError } = require('../src/services/activity');
const { createCoalescedBackgroundTask } = require('../src/utils/request-coordination');

test('战令通知在已领取到当前等级时跳过请求', () => {
    assert.equal(getBattlePassNotifyClaimability({
        current_level: '12',
        claimed_through_level: '12',
        nodes: [{ node_id: '12' }],
    }), false);
    assert.equal(getBattlePassNotifyClaimability({
        current_level: '12',
        claimed_through_level: '11',
        nodes: [{ node_id: '12' }],
    }), true);
    assert.equal(getBattlePassNotifyClaimability({
        current_level: '12',
        claimed_through_level: '11',
        nodes: [],
    }), null);
});

test('没有可领取奖励属于正常空结果', () => {
    assert.equal(isNoBattlePassRewardError({ code: 'NO_PASS_REWARD', message: '当前没有可领取的游记奖励' }), true);
    assert.equal(isNoBattlePassRewardError(new Error('当前没有可领取的游记奖励')), true);
    assert.equal(isNoBattlePassRewardError(new Error('请求超时')), false);
});

test('战令推送突发只触发一次后台领取', async () => {
    let calls = 0;
    const task = createCoalescedBackgroundTask(() => {
        calls += 1;
    }, { delayMs: 5 });

    for (let index = 0; index < 20; index += 1) task.trigger();
    await delay(30);

    assert.equal(calls, 1);
    task.cancel();
});

test('领取进行中的重复推送最多追加一次尾随领取', async () => {
    let calls = 0;
    let releaseFirst;
    let markStarted;
    const firstStarted = new Promise(resolve => { markStarted = resolve; });
    const task = createCoalescedBackgroundTask(async () => {
        calls += 1;
        if (calls === 1) {
            markStarted();
            await new Promise(resolve => { releaseFirst = resolve; });
        }
    }, { delayMs: 5 });

    task.trigger();
    await firstStarted;
    for (let index = 0; index < 20; index += 1) task.trigger();
    releaseFirst();
    await delay(30);

    assert.equal(calls, 2);
    task.cancel();
});

export {};
