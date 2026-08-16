const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { createWorkerBattlePassPushRuntime } = require('../src/runtime/worker-battle-pass');

async function waitFor(predicate, timeoutMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('等待 Worker 战令推送处理超时');
        await delay(5);
    }
}

function createHarness(overrides = {}) {
    const events = new EventEmitter();
    const logs = [];
    let active = true;
    let claimCalls = 0;
    const activityService = {
        async claimBattlePassRewards() {
            claimCalls += 1;
            return { rewards: [{ id: 1 }] };
        },
        getBattlePassNotifyClaimability(pass) {
            return pass?.claimable ?? null;
        },
        isNoBattlePassRewardError(error) {
            return error?.code === 'NO_PASS_REWARD';
        },
        ...overrides,
    };
    const runtime = createWorkerBattlePassPushRuntime({
        events,
        activityService,
        isLifecycleActive: () => active,
        log: (tag, message, meta) => logs.push({ tag, message, meta }),
        delayMs: 5,
    });
    return {
        activityService,
        events,
        logs,
        runtime,
        claimCalls: () => claimCalls,
        deactivate() { active = false; },
        activate() { active = true; },
    };
}

test('Worker 登录后注册战令监听并合并突发推送', async (t) => {
    const harness = createHarness();
    t.after(() => harness.runtime.stop());

    harness.runtime.start();
    harness.runtime.start();
    assert.equal(harness.events.listenerCount('battlePassNotify'), 1);

    harness.events.emit('battlePassNotify', { claimable: false });
    await delay(20);
    assert.equal(harness.claimCalls(), 0);

    for (let index = 0; index < 20; index += 1) {
        harness.events.emit('battlePassNotify', { claimable: true });
    }
    await waitFor(() => harness.claimCalls() === 1);

    assert.equal(harness.logs.length, 1);
    assert.equal(harness.logs[0].meta.event, 'battle_pass_push_claim');
    assert.equal(harness.logs[0].meta.count, 1);
});

test('Worker 停止会移除监听并取消尚未执行的领取', async () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.events.emit('battlePassNotify', { claimable: true });
    harness.runtime.stop();

    await delay(20);
    assert.equal(harness.claimCalls(), 0);
    assert.equal(harness.events.listenerCount('battlePassNotify'), 0);

    harness.runtime.start();
    harness.events.emit('battlePassNotify', { claimable: true });
    await waitFor(() => harness.claimCalls() === 1);
    harness.runtime.stop();
});

test('Worker 生命周期结束后不会记录在途领取的成功结果', async () => {
    let releaseClaim;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const harness = createHarness({
        async claimBattlePassRewards() {
            markStarted();
            await new Promise(resolve => { releaseClaim = resolve; });
            return { rewards: [{ id: 1 }] };
        },
    });

    harness.runtime.start();
    harness.events.emit('battlePassNotify', { claimable: true });
    await started;
    harness.deactivate();
    harness.runtime.stop();
    releaseClaim();
    await delay(20);

    assert.equal(harness.logs.length, 0);
    assert.equal(harness.events.listenerCount('battlePassNotify'), 0);
});

test('Worker 静默忽略空奖励并保留真实领取错误', async (t) => {
    let calls = 0;
    const harness = createHarness({
        async claimBattlePassRewards() {
            calls += 1;
            if (calls === 1) throw Object.assign(new Error('当前没有可领取的游记奖励'), { code: 'NO_PASS_REWARD' });
            throw new Error('活动请求超时');
        },
    });
    t.after(() => harness.runtime.stop());
    harness.runtime.start();

    harness.events.emit('battlePassNotify', { claimable: true });
    await waitFor(() => calls === 1);
    await delay(10);
    assert.equal(harness.logs.length, 0);

    harness.events.emit('battlePassNotify', { claimable: true });
    await waitFor(() => calls === 2);
    await waitFor(() => harness.logs.length === 1);
    assert.equal(harness.logs[0].meta.event, 'battle_pass_push_claim_error');
    assert.match(harness.logs[0].message, /活动请求超时/);
});

export {};
