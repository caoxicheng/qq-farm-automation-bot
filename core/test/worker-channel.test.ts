const assert = require('node:assert/strict');
const test = require('node:test');
const { flushWorkerMessage, sendWorkerMessage } = require('../src/runtime/worker-channel');

test('普通消息优先使用 fork 通道并在线程环境回退到 parentPort', () => {
    const calls = [];
    const processRef = { send: payload => calls.push(['fork', payload]) };
    const parentPort = { postMessage: payload => calls.push(['thread', payload]) };

    assert.equal(sendWorkerMessage(processRef, parentPort, { type: 'ping' }), true);
    assert.deepEqual(calls, [['fork', { type: 'ping' }]]);

    assert.equal(sendWorkerMessage({}, parentPort, { type: 'pong' }), true);
    assert.deepEqual(calls[1], ['thread', { type: 'pong' }]);
    assert.equal(sendWorkerMessage({}, null, { type: 'ignored' }), false);
});

test('fork 消息等待 process.send 回调后才完成', async () => {
    let callback;
    let completed = false;
    const processRef = {
        send(_payload, onSent) {
            callback = onSent;
        },
    };

    const pending = flushWorkerMessage(processRef, null, { type: 'reauth_required' });
    pending.then(() => {
        completed = true;
    });
    await Promise.resolve();
    assert.equal(completed, false);

    callback();
    await pending;
    assert.equal(completed, true);
});

test('fork IPC 无回调时按超时释放退出流程', async () => {
    const processRef = { send() {} };
    const startedAt = Date.now();

    await flushWorkerMessage(processRef, null, { type: 'reauth_required' }, 10);

    assert.ok(Date.now() - startedAt >= 5);
});

test('线程消息在事件循环刷新后完成', async () => {
    const sent = [];
    await flushWorkerMessage({}, { postMessage: payload => sent.push(payload) }, { type: 'status_sync' });
    assert.deepEqual(sent, [{ type: 'status_sync' }]);
});

test('发送通道抛错时安全结束退出流程', async () => {
    await flushWorkerMessage({ send() { throw new Error('closed'); } }, null, { type: 'stop' });
    await flushWorkerMessage({}, { postMessage() { throw new Error('closed'); } }, { type: 'stop' });
});
export {};
