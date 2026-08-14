const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createDataProvider } = require('../src/runtime/data-provider');
const { createWorkerManager } = require('../src/runtime/worker-manager');

class FakeWorker extends EventEmitter {
    constructor() {
        super();
        this.sent = [];
    }

    postMessage(payload) {
        this.sent.push(payload);
        if (payload.type === 'stop') {
            queueMicrotask(() => this.emit('exit', 0, null));
        }
    }

    terminate() {
        queueMicrotask(() => this.emit('exit', 0, null));
        return Promise.resolve();
    }
}

function createHarness() {
    const workers = {};
    const accountLogs = [];
    const statuses = [];
    const reauthRequiredStates = new Map();
    const manager = createWorkerManager({
        WorkerThread: FakeWorker,
        runtimeMode: 'thread',
        processRef: { env: {}, pkg: false },
        mainEntryPath: '',
        workerScriptPath: '',
        workers,
        globalLogs: [],
        log: () => {},
        addAccountLog: (...args) => accountLogs.push(args),
        normalizeStatusForPanel: value => value,
        buildConfigSnapshotForAccount: () => ({}),
        getOfflineAutoDeleteMs: () => Number.POSITIVE_INFINITY,
        triggerOfflineReminder: () => {},
        addOrUpdateAccount: () => {},
        deleteAccount: () => {},
        getAutoRelogin: () => null,
        getAccounts: () => ({ accounts: [] }),
        reauthRequiredStates,
        onStatusSync: (_accountId, status) => statuses.push(status),
        onWorkerLog: () => {},
    });
    const account = { id: '12', name: '测试账号', platform: 'wx', code: 'old-code' };
    assert.equal(manager.startWorker(account), true);
    return { manager, workers, accountLogs, statuses, reauthRequiredStates, account };
}

test('可自动恢复的网关 400 不向面板暴露重新认证提示', async (t) => {
    const harness = createHarness();
    t.after(() => harness.manager.stopWorker(harness.account.id));

    harness.workers[harness.account.id].process.emit('message', {
        type: 'ws_error',
        code: 400,
        message: 'code expired',
    });

    assert.equal(harness.workers[harness.account.id].wsError, null);
    assert.equal(harness.accountLogs.length, 0);
    assert.equal(harness.statuses.length, 0);
});

test('自动恢复失败后才向面板发送重新认证提示', async (t) => {
    const harness = createHarness();
    t.after(() => harness.manager.stopWorker(harness.account.id));

    harness.workers[harness.account.id].process.emit('message', {
        type: 'reauth_required',
        code: 400,
        message: 'refresh token expired',
    });

    assert.deepEqual(harness.workers[harness.account.id].wsError, {
        code: 400,
        message: 'refresh token expired',
        at: harness.workers[harness.account.id].wsError.at,
    });
    assert.equal(harness.accountLogs[0][0], 'reauth_required');
    assert.equal(harness.statuses[0].wsError.message, 'refresh token expired');
    assert.equal(harness.reauthRequiredStates.get(harness.account.id).message, 'refresh token expired');
});

test('Worker 退出后仍可查询重新认证状态，连接成功后才清除', async (t) => {
    const harness = createHarness();
    t.after(() => harness.manager.stopWorker(harness.account.id));

    const firstWorker = harness.workers[harness.account.id].process;
    firstWorker.emit('message', {
        type: 'reauth_required',
        code: 400,
        message: 'refresh token expired',
    });
    firstWorker.emit('exit', 0, null);

    const provider = createDataProvider({
        workers: harness.workers,
        reauthRequiredStates: harness.reauthRequiredStates,
        getAccounts: () => ({ accounts: [harness.account] }),
        buildDefaultStatus: accountId => ({ accountId, wsError: null }),
        normalizeStatusForPanel: value => value,
    });
    assert.equal(provider.getStatus(harness.account.id).wsError.message, 'refresh token expired');

    assert.equal(harness.manager.startWorker(harness.account), true);
    harness.workers[harness.account.id].process.emit('message', {
        type: 'status_sync',
        data: { connection: { connected: true } },
    });

    assert.equal(harness.reauthRequiredStates.has(harness.account.id), false);
    assert.equal(provider.getStatus(harness.account.id).wsError, null);
});
