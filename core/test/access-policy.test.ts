const assert = require('node:assert/strict');
const test = require('node:test');
const { canAccessAccount, filterLogsByAccountIds } = require('../src/services/access-policy');

test('管理员可访问任意账号，普通用户只能访问自己的账号', () => {
    const account = { id: '1', username: 'alice' };
    assert.equal(canAccessAccount({ role: 'admin', username: 'root' }, null), true);
    assert.equal(canAccessAccount({ role: 'user', username: 'alice' }, account), true);
    assert.equal(canAccessAccount({ role: 'user', username: 'bob' }, account), false);
    assert.equal(canAccessAccount(null, account), false);
});

test('实时日志按可访问账号过滤并按类型决定是否保留系统日志', () => {
    const logs = [
        { accountId: '1', message: 'own' },
        { id: '2', message: 'other' },
        { message: 'system' },
    ];

    assert.deepEqual(filterLogsByAccountIds(logs, ['1'], true).map(item => item.message), ['own', 'system']);
    assert.deepEqual(filterLogsByAccountIds(logs, ['1'], false).map(item => item.message), ['own']);
});
export {};
