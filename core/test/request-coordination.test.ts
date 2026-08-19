const test = require('node:test');
const assert = require('node:assert/strict');
const {
    canReserveRequest,
    capturePostMutationSnapshot,
    createSingleFlight,
    createTimeoutBudget,
    retryFailedSnapshotSection,
    settleSequentially,
    withTimeout,
} = require('../src/utils/request-coordination');

test('普通业务最多占四槽并为控制请求保留第五槽', () => {
    const business = Array.from({ length: 4 }, () => ({ category: 'business' }));
    assert.equal(canReserveRequest(business, 'business'), false);
    assert.equal(canReserveRequest(business, 'control'), true);
    assert.equal(canReserveRequest([...business, { category: 'control' }], 'control'), false);
});

test('single-flight 复用在途 Promise 并在完成后允许新请求', async () => {
    let calls = 0;
    let release;
    const run = createSingleFlight(() => {
        calls += 1;
        return new Promise(resolve => { release = resolve; });
    });
    const first = run();
    const second = run();
    assert.equal(first, second);
    assert.equal(calls, 1);
    release('ok');
    assert.equal(await first, 'ok');
    const third = run();
    assert.notEqual(third, first);
    assert.equal(calls, 2);
    release('next');
    assert.equal(await third, 'next');
});

test('single-flight 失败后会释放在途状态', async () => {
    let calls = 0;
    const run = createSingleFlight(async () => {
        calls += 1;
        if (calls === 1) throw new Error('failed');
        return 'recovered';
    });
    await assert.rejects(run(), /failed/);
    assert.equal(await run(), 'recovered');
});

test('网关读取按声明顺序串行执行并保留分区失败', async () => {
    const events = [];
    const results = await settleSequentially([
        async () => {
            events.push('season:start');
            await Promise.resolve();
            events.push('season:end');
            return 'season';
        },
        async () => {
            events.push('solar');
            throw new Error('solar failed');
        },
        async () => {
            events.push('bag');
            return 'bag';
        },
    ]);

    assert.deepEqual(events, ['season:start', 'season:end', 'solar', 'bag']);
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.equal(results[0].value, 'season');
    assert.match(results[1].reason.message, /solar failed/);
    assert.equal(results[2].value, 'bag');
});

test('串行请求共享总超时预算并限制单次等待时间', () => {
    let now = 1_000;
    const nextTimeout = createTimeoutBudget(20_000, 5_000, () => now);

    assert.equal(nextTimeout(), 5_000);
    now += 17_500;
    assert.equal(nextTimeout(), 2_500);
    now += 2_500;
    assert.throws(() => nextTimeout(), /总超时预算已耗尽/);
});

test('共享请求允许不同调用方按各自截止时间结束等待', async () => {
    let release;
    const shared = new Promise(resolve => { release = resolve; });
    const longWait = withTimeout(shared, 100, 'long timeout');
    const shortWait = withTimeout(shared, 5, 'short timeout');

    await assert.rejects(shortWait, error => error?.code === 'OPERATION_TIMEOUT' && /short timeout/.test(error.message));
    release('ok');
    assert.equal(await longWait, 'ok');
});

test('部分快照失败时仅补读失败分区并清除错误', async () => {
    const snapshot = { qingMei: null, season: { id: 'season' }, errors: { qingMei: 'timeout', season: null } };
    const result = await retryFailedSnapshotSection(snapshot, 'qingMei', async () => ({ activityId: '2026081202' }));

    assert.deepEqual(result.qingMei, { activityId: '2026081202' });
    assert.equal(result.errors.qingMei, null);
    assert.equal(result.season, snapshot.season);
});

test('分区已有数据时不发起补读', async () => {
    let calls = 0;
    const snapshot = { qingMei: { activityId: '2026081202' }, errors: { qingMei: null } };
    const result = await retryFailedSnapshotSection(snapshot, 'qingMei', async () => {
        calls += 1;
        return {};
    });

    assert.equal(result, snapshot);
    assert.equal(calls, 0);
});

test('分区补读仍失败时保留原快照并记录二次错误', async () => {
    const snapshot = { qingMei: null, errors: { qingMei: 'first timeout' } };
    const result = await retryFailedSnapshotSection(snapshot, 'qingMei', async () => {
        throw new Error('retry timeout');
    });

    assert.equal(result.qingMei, null);
    assert.match(result.errors.qingMei, /first timeout; 补读失败: retry timeout/);
});

test('写操作后的快照失败不会覆盖已经成功的写结果', async () => {
    const result = await capturePostMutationSnapshot(async () => {
        throw new Error('snapshot timeout');
    });

    assert.equal(result.snapshot, null);
    assert.equal(result.snapshotError, 'snapshot timeout');
});

test('写操作后的快照成功时保留完整快照', async () => {
    const snapshot = { qingMei: { activityId: '2026081202' } };
    const result = await capturePostMutationSnapshot(async () => snapshot);

    assert.equal(result.snapshot, snapshot);
    assert.equal(result.snapshotError, null);
});
export {};
