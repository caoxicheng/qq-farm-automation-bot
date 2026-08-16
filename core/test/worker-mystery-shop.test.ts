const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { createWorkerMysteryShopRuntime } = require('../src/runtime/worker-mystery-shop');

function createOffer(overrides = {}) {
    return {
        key: '1007:1786955583',
        npcId: '1007',
        expireTime: 1786955583,
        reward: { id: '21135', count: '8', name: '艾草种子', image: '' },
        currency: {
            id: '1001',
            name: '金币',
            unitPrice: '5000',
            totalPrice: '40000',
            originalUnitPrice: '10000',
            originalTotalPrice: '80000',
        },
        discountPercent: 50,
        ...overrides,
    };
}

function createHarness(overrides = {}) {
    const events = new EventEmitter();
    const logs = [];
    let active = true;
    let enabled = true;
    let buyCalls = 0;
    const offer = createOffer();
    const service = {
        async buyNpcGoods() {
            buyCalls += 1;
            return { rewards: [{ id: '21135', count: '8', name: '艾草种子' }] };
        },
        async getActiveNPC() {
            return offer;
        },
        mysteryRewards(value) {
            return value?.rewards || [];
        },
        normalizeMysteryShopOffer(value) {
            return value?.key ? value : null;
        },
        ...overrides,
    };
    const runtime = createWorkerMysteryShopRuntime({
        events,
        getAutomation: () => ({ mystery_shop_buy: enabled }),
        isLifecycleActive: () => active,
        log: (tag, message, meta) => logs.push({ tag, message, meta }),
        now: () => 1786870000 * 1000,
        service,
    });
    return {
        events,
        logs,
        offer,
        runtime,
        buyCalls: () => buyCalls,
        setActive(value) { active = value; },
        setEnabled(value) { enabled = value; },
    };
}

test('神秘商人推送监听只注册一次，并合并同一商品的突发通知', async (t) => {
    let releaseBuy;
    const harness = createHarness({
        async buyNpcGoods() {
            await new Promise(resolve => { releaseBuy = resolve; });
            return { rewards: [{ id: '21135', count: '8', name: '艾草种子' }] };
        },
    });
    t.after(() => harness.runtime.stop());
    harness.runtime.start();
    harness.runtime.start();
    assert.equal(harness.events.listenerCount('mysteryShopNotify'), 1);

    const pending = harness.runtime.handleOffer(harness.offer);
    const duplicatePending = harness.runtime.handleOffer(harness.offer);
    releaseBuy();
    const [first, second] = await Promise.all([pending, duplicatePending]);

    assert.equal(first.outcome, 'purchased');
    assert.equal(second.outcome, 'purchased');
    assert.equal(harness.logs.length, 1);
    assert.equal(harness.logs[0].meta.event, 'auto_buy');

    assert.equal((await harness.runtime.handleOffer(harness.offer)).outcome, 'duplicate');
    assert.equal(harness.logs.length, 1);
});

test('自动购买关闭时忽略推送，开启后立即查询并购买', async (t) => {
    const harness = createHarness();
    t.after(() => harness.runtime.stop());
    harness.runtime.start();
    harness.setEnabled(false);

    harness.events.emit('mysteryShopNotify', harness.offer);
    await delay(10);
    assert.equal(harness.buyCalls(), 0);
    assert.equal((await harness.runtime.checkNow()).outcome, 'disabled');

    harness.setEnabled(true);
    assert.equal((await harness.runtime.checkNow()).outcome, 'purchased');
    assert.equal(harness.buyCalls(), 1);
});

test('购买失败不写入去重状态，后续同轮推送可以重试', async (t) => {
    let calls = 0;
    const harness = createHarness({
        async buyNpcGoods() {
            calls += 1;
            if (calls === 1) throw new Error('临时网络错误');
            return { rewards: [{ id: '21135', count: '8', name: '艾草种子' }] };
        },
    });
    t.after(() => harness.runtime.stop());

    assert.equal((await harness.runtime.handleOffer(harness.offer)).outcome, 'failed');
    assert.equal((await harness.runtime.handleOffer(harness.offer)).outcome, 'purchased');
    assert.equal(calls, 2);
    assert.equal(harness.logs[0].meta.result, 'error');
    assert.equal(harness.logs[1].meta.result, 'ok');
});

test('过期商品和已停止 Worker 都不会下单', async (t) => {
    const harness = createHarness();
    t.after(() => harness.runtime.stop());

    assert.equal((await harness.runtime.handleOffer(createOffer({ expireTime: 1786869999 }))).outcome, 'expired');
    harness.setActive(false);
    assert.equal((await harness.runtime.handleOffer(harness.offer)).outcome, 'stopped');
    assert.equal(harness.buyCalls(), 0);
});

export {};
