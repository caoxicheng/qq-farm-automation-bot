const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runtimePathsModule = require.resolve('../src/config/runtime-paths');
const userStoreModule = require.resolve('../src/models/user-store');
const originalRuntimePaths = require(runtimePathsModule);

function createIsolatedUserStore(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-user-store-'));
    require.cache[runtimePathsModule].exports = {
        ...originalRuntimePaths,
        ensureDataDir: () => root,
        getDataDir: () => root,
        getDataFile: name => path.join(root, name),
    };
    delete require.cache[userStoreModule];
    const userStore = require(userStoreModule);
    t.after(() => {
        delete require.cache[userStoreModule];
        require.cache[runtimePathsModule].exports = originalRuntimePaths;
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, userStore };
}

test('用户、卡密和登录记录均通过隔离目录原子持久化', (t) => {
    const { root, userStore } = createIsolatedUserStore(t);
    assert.equal(userStore.getAllUsers().some(user => user.username === 'admin'), true);

    const card = userStore.createCard('测试时间卡', 7);
    const registration = userStore.registerUser('alice', 'Strong123', card.code);
    assert.equal(registration.ok, true);
    assert.equal(userStore.validateUser('alice', 'Strong123', '127.0.0.1').username, 'alice');
    userStore.addLoginLog({ event: 'login_success', username: 'alice' });

    for (const filename of ['users.json', 'cards.json', 'login-attempts.json', 'login-logs.json']) {
        assert.equal(fs.existsSync(path.join(root, filename)), true, filename);
    }
    assert.deepEqual(fs.readdirSync(root).filter(filename => filename.endsWith('.tmp')), []);
});

test('首次读取卡密领取配置保持历史默认开启行为', (t) => {
    const { root, userStore } = createIsolatedUserStore(t);
    assert.deepEqual(userStore.getCardClaimStatus(), { enabled: true });
    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'card-claim.json'), 'utf8'));
    assert.deepEqual(persisted, { enabled: true, records: [] });
});
export {};
