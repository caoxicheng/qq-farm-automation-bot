const assert = require('node:assert/strict');
const test = require('node:test');
const { flushWorkerMessage } = require('../src/runtime/worker-channel');

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
