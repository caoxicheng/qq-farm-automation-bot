const assert = require('node:assert/strict');
const test = require('node:test');
const {
    replaceSocketAccountRoom,
    resolveSocketIdentity,
    resolveSocketSubscriptionTarget,
} = require('../src/controllers/admin-socket');

test('Socket 身份只接受同时存在于令牌集和用户映射的令牌', () => {
    const tokens = new Set(['auth-token', 'header-token', 'stale-token']);
    const users = new Map([
        ['auth-token', { username: 'alice' }],
        ['header-token', { username: 'bob' }],
    ]);

    assert.deepEqual(resolveSocketIdentity({
        auth: { token: 'auth-token' },
        headers: { 'x-admin-token': 'header-token' },
    }, tokens, users), {
        token: 'auth-token',
        user: { username: 'alice' },
    });
    assert.deepEqual(resolveSocketIdentity({
        auth: {},
        headers: { 'x-admin-token': 'header-token' },
    }, tokens, users), {
        token: 'header-token',
        user: { username: 'bob' },
    });
    assert.equal(resolveSocketIdentity({ auth: { token: 'stale-token' }, headers: {} }, tokens, users), null);
    assert.equal(resolveSocketIdentity({ auth: { token: 'unknown' }, headers: {} }, tokens, users), null);
});

test('Socket 订阅拒绝越权账号并允许订阅自己的账号或全部频道', () => {
    const accounts = [
        { id: '1', username: 'alice' },
        { id: '2', username: 'bob' },
    ];
    const getAccounts = () => accounts;
    const resolveAccountId = value => String(value || '');
    const canAccessAccount = (user, account) => user.role === 'admin' || user.username === account?.username;
    const alice = { role: 'user', username: 'alice' };

    assert.deepEqual(resolveSocketSubscriptionTarget('1', alice, getAccounts, resolveAccountId, canAccessAccount), {
        accountId: '1',
    });
    assert.deepEqual(resolveSocketSubscriptionTarget('2', alice, getAccounts, resolveAccountId, canAccessAccount), {
        accountId: '',
        error: '无权访问此账号',
    });
    assert.deepEqual(resolveSocketSubscriptionTarget('all', alice, () => {
        throw new Error('订阅全部频道不应读取账号列表');
    }, resolveAccountId, canAccessAccount), {
        accountId: '',
    });
    assert.deepEqual(resolveSocketSubscriptionTarget('1', null, getAccounts, resolveAccountId, canAccessAccount), {
        accountId: '',
        error: 'Unauthorized',
    });
});

test('Socket 切换订阅时离开旧账号房间并保留非账号房间', () => {
    const socket: {
        data: { accountId?: string };
        rooms: Set<string>;
        join: (room: string) => void;
        leave: (room: string) => void;
    } = {
        data: {},
        rooms: new Set(['socket-id', 'account:old', 'custom-room']),
        join(room) { this.rooms.add(room); },
        leave(room) { this.rooms.delete(room); },
    };

    replaceSocketAccountRoom(socket, 'next');
    assert.deepEqual([...socket.rooms].sort(), ['account:next', 'custom-room', 'socket-id']);
    assert.equal(socket.data.accountId, 'next');

    replaceSocketAccountRoom(socket, '');
    assert.deepEqual([...socket.rooms].sort(), ['account:all', 'custom-room', 'socket-id']);
    assert.equal(socket.data.accountId, '');
});

export {};
