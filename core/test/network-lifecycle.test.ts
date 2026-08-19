const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { after, afterEach, before, test } = require('node:test');

const wsModulePath = require.resolve('ws');
const originalWebSocket = require(wsModulePath);

class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor(url, options) {
        super();
        this.url = url;
        this.options = options;
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }

    send(payload, callback) {
        this.sent.push(payload);
        queueMicrotask(() => callback && callback(null));
    }

    close() {
        this.readyState = FakeWebSocket.CLOSED;
    }
}

require.cache[wsModulePath].exports = FakeWebSocket;
const networkModulePath = require.resolve('../src/utils/network');
delete require.cache[networkModulePath];
const { loadProto } = require('../src/utils/proto');
const network = require('../src/utils/network');

before(async () => {
    await loadProto();
});

afterEach(() => {
    network.cleanup('测试清理');
});

after(() => {
    network.cleanup('测试结束');
    require.cache[wsModulePath].exports = originalWebSocket;
    delete require.cache[networkModulePath];
});

function connectFake() {
    network.connect('test-code', () => {});
    return FakeWebSocket.instances.at(-1);
}

test('请求超时会释放请求槽并允许后续请求进入', async () => {
    connectFake();

    await assert.rejects(
        network.sendMsgAsync('TestService', 'First', Buffer.alloc(0), 5),
        error => error && error.code === 'REQUEST_TIMEOUT',
    );

    await assert.rejects(
        network.sendMsgAsync('TestService', 'Second', Buffer.alloc(0), 5),
        error => error && error.code === 'REQUEST_TIMEOUT',
    );
});

test('业务请求槽满时错误包含活跃请求与入站诊断', async () => {
    connectFake();
    const pending = ['One', 'Two', 'Three', 'Four'].map(method => (
        network.sendMsgAsync('TestService', method, Buffer.alloc(0), 1000)
    ));
    const rejections = pending.map(request => assert.rejects(request, /请求已中断: 诊断测试清理/));
    await new Promise(resolve => setImmediate(resolve));

    await assert.rejects(
        network.sendMsgAsync('TestService', 'Overflow', Buffer.alloc(0), 1000),
        error => /请求队列已满: Overflow/.test(error.message)
            && /active=.*One/.test(error.message)
            && /lastInbound=\d+ms/.test(error.message),
    );

    network.cleanup('诊断测试清理');
    await Promise.all(rejections);
});

test('网络清理会拒绝全部在途请求并清除超时任务', async () => {
    connectFake();
    const pending = network.sendMsgAsync('TestService', 'Pending', Buffer.alloc(0), 1000);
    const rejection = assert.rejects(pending, /请求已中断: 主动测试/);
    await new Promise(resolve => setImmediate(resolve));

    network.cleanup('主动测试');

    await rejection;
});

test('主动重连会隔离旧连接事件并中断旧连接请求', async () => {
    const oldSocket = connectFake();
    const oldPending = network.sendMsgAsync('TestService', 'OldRequest', Buffer.alloc(0), 1000);
    const oldRejection = assert.rejects(oldPending, /请求已中断: 主动重连/);
    await new Promise(resolve => setImmediate(resolve));

    network.reconnect('new-code');
    await oldRejection;
    const newSocket = FakeWebSocket.instances.at(-1);
    assert.notEqual(newSocket, oldSocket);
    assert.equal(oldSocket.listenerCount('message'), 0);

    let newSettled = false;
    const newPending = network.sendMsgAsync('TestService', 'NewRequest', Buffer.alloc(0), 1000);
    newPending.then(() => { newSettled = true; }, () => { newSettled = true; });
    oldSocket.emit('message', Buffer.from([0]));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(newSettled, false);

    const newRejection = assert.rejects(newPending, /请求已中断: 测试结束新请求/);
    network.cleanup('测试结束新请求');
    await newRejection;
});
export {};
