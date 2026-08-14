const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAccountRepository } = require('../src/models/account-repository');
const { createKnownFriendCache } = require('../src/models/known-friend-cache');
const { readJsonFile, writeJsonFileAtomic } = require('../src/services/json-db');

function createDependencies(root) {
    return {
        ensureDataDir: () => root,
        getDataFile: name => path.join(root, name),
        readJsonFile,
        writeJsonFileAtomic,
    };
}

test('账号仓储实例不会跨数据目录共享路径', (t) => {
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-account-repo-a-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-account-repo-b-'));
    t.after(() => {
        fs.rmSync(firstRoot, { recursive: true, force: true });
        fs.rmSync(secondRoot, { recursive: true, force: true });
    });

    const first = createAccountRepository(createDependencies(firstRoot));
    const second = createAccountRepository(createDependencies(secondRoot));
    first.saveAccounts({ accounts: [{ id: '7', name: 'A' }], nextId: 8 });
    second.saveAccounts({ accounts: [{ id: '2', name: 'B' }], nextId: 3 });

    assert.deepEqual(first.loadAccounts().accounts.map(account => account.id), ['7']);
    assert.deepEqual(second.loadAccounts().accounts.map(account => account.id), ['2']);
});

test('好友缓存将账号引用限制为目录内安全文件名', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-friend-cache-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dependencies = createDependencies(root);
    const cache = createKnownFriendCache(dependencies);

    cache.write('../../outside/account', [11, 22]);
    assert.deepEqual(cache.read('../../outside/account'), [11, 22]);

    const files = fs.readdirSync(path.join(root, 'known_friend_gids'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^[\w-]+\.json$/);
    assert.equal(fs.existsSync(path.join(root, '..', 'outside', 'account.json')), false);
});
export {};
