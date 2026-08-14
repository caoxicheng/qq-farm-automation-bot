const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runtimePathsModule = require.resolve('../src/config/runtime-paths');
const storeModule = require.resolve('../src/models/store');
const originalRuntimePaths = require(runtimePathsModule);

function createIsolatedStore(t, files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-store-test-'));
    for (const [name, value] of Object.entries(files)) {
        fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2), 'utf8');
    }

    require.cache[runtimePathsModule].exports = {
        ...originalRuntimePaths,
        ensureDataDir: () => root,
        getDataDir: () => root,
        getDataFile: name => path.join(root, name),
    };
    delete require.cache[storeModule];
    const store = require(storeModule);

    t.after(() => {
        delete require.cache[storeModule];
        require.cache[runtimePathsModule].exports = originalRuntimePaths;
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, store };
}

test('旧配置加载时按白名单归一化并迁移全局下线提醒', (t) => {
    const { store } = createIsolatedStore(t, {
        'store.json': {
            accountConfigs: {
                7: {
                    automation: { farm: 0, fertilizer: 'invalid', unknownFlag: true },
                    plantingStrategy: 'invalid',
                    plantBlacklist: ['20002', -1, 'bad'],
                    stealDelaySeconds: 999,
                },
            },
            offlineReminder: {
                channel: 'webhook',
                endpoint: 'https://example.invalid/hook',
                title: '旧提醒',
            },
        },
    });

    const config = store.getConfigSnapshot('7');
    assert.equal(config.automation.farm, false);
    assert.equal(config.automation.fertilizer, 'smart');
    assert.equal(Object.hasOwn(config.automation, 'unknownFlag'), false);
    assert.equal(config.plantingStrategy, 'max_exp');
    assert.deepEqual(config.plantBlacklist, [20002]);
    assert.equal(config.stealDelaySeconds, 300);
    assert.equal(store.getOfflineReminder('admin').title, '旧提醒');
});

test('旧账号 nextId 落后时会校准并为新账号生成唯一 id', (t) => {
    const { root, store } = createIsolatedStore(t, {
        'accounts.json': {
            accounts: [{ id: '5', name: '旧账号', username: 'alice' }],
            nextId: 2,
        },
    });

    assert.equal(store.getAccounts().nextId, 6);
    const next = store.addOrUpdateAccount({ name: '新账号', username: 'alice', platform: 'qq' });
    assert.deepEqual(next.accounts.map(account => account.id), ['5', '6']);

    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'accounts.json'), 'utf8'));
    assert.equal(persisted.nextId, 7);
    assert.equal(persisted.accounts[1].name, '新账号');
});
export {};
