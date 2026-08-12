const test = require('node:test');
const assert = require('node:assert/strict');
const { canReserveRequest, createSingleFlight } = require('../src/utils/request-coordination');

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
