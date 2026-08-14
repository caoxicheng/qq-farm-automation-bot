const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createWorkerManager } = require('../src/runtime/worker-manager');

class FakeScheduler {
    tasks: Map<string, any>;

    constructor() {
        this.tasks = new Map();
    }

    clear(name) {
        return this.tasks.delete(String(name));
    }

    clearAll() {
        this.tasks.clear();
    }

    setTimeoutTask(name, delayMs, task) {
        this.tasks.set(String(name), { kind: 'timeout', delayMs, task });
        return name;
    }

    setIntervalTask(name, delayMs, task) {
        this.tasks.set(String(name), { kind: 'interval', delayMs, task });
        return name;
    }

    async run(name) {
        const key = String(name);
        const entry = this.tasks.get(key);
        assert.ok(entry, `missing scheduled task: ${key}`);
        if (entry.kind === 'timeout') this.tasks.delete(key);
        return entry.task();
    }
}

class FakeWorker extends EventEmitter {
    static instances = [];

    constructor() {
        super();
        this.sent = [];
        this.terminated = false;
        FakeWorker.instances.push(this);
    }

    postMessage(payload) {
        this.sent.push(payload);
        if (payload.type === 'stop') {
            queueMicrotask(() => this.emit('exit', 0, null));
        }
    }

    terminate() {
        this.terminated = true;
        queueMicrotask(() => this.emit('exit', 1, 'SIGTERM'));
        return Promise.resolve();
    }
}

function createHarness() {
    FakeWorker.instances = [];
    const scheduler = new FakeScheduler();
    const workers = {};
    let now = 0;
    const manager = createWorkerManager({
        WorkerThread: FakeWorker,
        runtimeMode: 'thread',
        processRef: { env: {}, pkg: false },
        mainEntryPath: '',
        workerScriptPath: '',
        workers,
        globalLogs: [],
        log: () => {},
        addAccountLog: () => {},
        normalizeStatusForPanel: value => value,
        buildConfigSnapshotForAccount: () => ({ automation: {} }),
        getOfflineAutoDeleteMs: () => Number.POSITIVE_INFINITY,
        triggerOfflineReminder: () => {},
        addOrUpdateAccount: () => {},
        deleteAccount: () => {},
        getAutoRelogin: () => null,
        getAccounts: () => ({ accounts: [] }),
        reauthRequiredStates: new Map(),
        scheduler,
        now: () => now,
    });
    const account = { id: '12', name: '测试账号', platform: 'qq', code: 'login-code' };
    return {
        account,
        manager,
        scheduler,
        workers,
        advance(ms) { now += ms; },
    };
}

function settleEvents() {
    return new Promise(resolve => setImmediate(resolve));
}

test('Worker 启动只允许一个实例并发送启动与配置快照', () => {
    const harness = createHarness();

    assert.equal(harness.manager.startWorker(harness.account), true);
    assert.equal(harness.manager.startWorker(harness.account), false);
    assert.equal(FakeWorker.instances.length, 1);
    assert.deepEqual(FakeWorker.instances[0].sent.slice(0, 2), [
        { type: 'start', config: { code: 'login-code', platform: 'qq' } },
        { type: 'config_sync', config: { automation: {} } },
    ]);
});

test('停止和重启 Worker 会清理旧实例且只启动一个新实例', async () => {
    const harness = createHarness();
    harness.manager.startWorker(harness.account);
    const first = FakeWorker.instances[0];

    harness.manager.restartWorker(harness.account);
    assert.equal(first.sent.at(-1).type, 'stop');
    await settleEvents();

    assert.equal(FakeWorker.instances.length, 2);
    assert.equal(harness.workers[harness.account.id].process, FakeWorker.instances[1]);

    harness.manager.stopWorker(harness.account.id);
    await settleEvents();
    assert.equal(harness.workers[harness.account.id], undefined);
});

test('Worker API 回包会完成请求并清除超时任务', async () => {
    const harness = createHarness();
    harness.manager.startWorker(harness.account);
    const worker = harness.workers[harness.account.id];

    const resultPromise = harness.manager.callWorkerApi(harness.account.id, 'getBag', 1);
    const request = worker.process.sent.at(-1);
    assert.deepEqual(request, { type: 'api_call', id: 1, method: 'getBag', args: [1] });
    assert.equal(harness.scheduler.tasks.has('api_timeout_12_1'), true);

    worker.process.emit('message', { type: 'api_response', id: 1, result: { items: [] } });
    assert.deepEqual(await resultPromise, { items: [] });
    assert.equal(worker.requests.size, 0);
    assert.equal(harness.scheduler.tasks.has('api_timeout_12_1'), false);
});

test('Worker API 超时和进程退出都会拒绝并释放在途请求', async () => {
    const timeoutHarness = createHarness();
    timeoutHarness.manager.startWorker(timeoutHarness.account);
    const timeoutPromise = timeoutHarness.manager.callWorkerApi(timeoutHarness.account.id, 'getBag');
    const timeoutAssertion = assert.rejects(timeoutPromise, /API Timeout/);
    await timeoutHarness.scheduler.run('api_timeout_12_1');
    await timeoutAssertion;
    assert.equal(timeoutHarness.workers[timeoutHarness.account.id].requests.size, 0);

    const exitHarness = createHarness();
    exitHarness.manager.startWorker(exitHarness.account);
    const exitPromise = exitHarness.manager.callWorkerApi(exitHarness.account.id, 'getBag');
    const exitAssertion = assert.rejects(exitPromise, /Worker exited/);
    exitHarness.workers[exitHarness.account.id].process.emit('exit', 1, null);
    await exitAssertion;
    assert.equal(exitHarness.workers[exitHarness.account.id], undefined);
    assert.equal(exitHarness.scheduler.tasks.has('api_timeout_12_1'), false);
});

test('watchdog 连续卡死只自动重启三次并在第四次停止', async () => {
    const harness = createHarness();
    harness.manager.startWorker(harness.account);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
        harness.advance(90000);
        await harness.scheduler.run('watchdog_12');
        assert.equal(FakeWorker.instances.at(-1).terminated, true);
        await settleEvents();
        await harness.scheduler.run('watchdog_restart_12');
        await settleEvents();

        if (attempt <= 3) {
            assert.ok(harness.workers[harness.account.id]);
        } else {
            assert.equal(harness.workers[harness.account.id], undefined);
        }
    }

    assert.equal(FakeWorker.instances.length, 4);
});
export {};
