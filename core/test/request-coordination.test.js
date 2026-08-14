const test = require('node:test');
const assert = require('node:assert/strict');
const {
    canReserveRequest,
    capturePostMutationSnapshot,
    createSingleFlight,
    retryFailedSnapshotSection,
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
