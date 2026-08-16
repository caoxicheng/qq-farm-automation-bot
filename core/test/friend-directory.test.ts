const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildFriendReply,
    dedupeFriendsByGid,
    extractReplyFriends,
    isEnterFarmBannedError,
    isInvalidFriendAccessError,
    isWithinFriendQuietHours,
    normalizeFriendGids,
} = require('../src/services/friend-directory');

test('好友 GID 规范化与列表去重保持首次出现顺序', () => {
    assert.deepEqual(normalizeFriendGids(['2', 1, 2, 0, 'bad', 3]), [2, 1, 3]);

    const friends = dedupeFriendsByGid([
        { gid: '2', name: 'first' },
        { gid: 2, name: 'duplicate' },
        { gid: 1, name: 'second' },
        { gid: 0, name: 'invalid' },
    ]);
    assert.deepEqual(friends.map(friend => friend.name), ['first', 'second']);

    const reply = buildFriendReply(friends);
    assert.equal(reply.game_friends, reply.gameFriends);
    assert.deepEqual(extractReplyFriends(reply), friends);
    assert.deepEqual(extractReplyFriends({ gameFriends: friends }), friends);
});

test('好友静默时段支持普通区间、跨日区间和全天配置', () => {
    const at = (hour, minute) => new Date(2026, 7, 15, hour, minute, 0, 0);

    assert.equal(isWithinFriendQuietHours({ enabled: true, start: '08:00', end: '10:00' }, at(9, 0)), true);
    assert.equal(isWithinFriendQuietHours({ enabled: true, start: '08:00', end: '10:00' }, at(10, 0)), false);
    assert.equal(isWithinFriendQuietHours({ enabled: true, start: '23:00', end: '06:00' }, at(1, 0)), true);
    assert.equal(isWithinFriendQuietHours({ enabled: true, start: '23:00', end: '06:00' }, at(12, 0)), false);
    assert.equal(isWithinFriendQuietHours({ enabled: true, start: '00:00', end: '00:00' }, at(12, 0)), true);
    assert.equal(isWithinFriendQuietHours({ enabled: true, start: 'bad', end: '06:00' }, at(1, 0)), false);
    assert.equal(isWithinFriendQuietHours({ enabled: false, start: '00:00', end: '00:00' }, at(1, 0)), false);
});

test('好友访问错误区分封禁、失效关系和瞬时网络异常', () => {
    const banned = new Error('rpc failed code=1002003 friend banned');
    const invalid = new Error('rpc failed code=1002004 friend not found');
    const timeout = new Error('rpc failed code=1002004 请求超时');

    assert.equal(isEnterFarmBannedError(banned), true);
    assert.equal(isInvalidFriendAccessError(banned), false);
    assert.equal(isInvalidFriendAccessError(invalid), true);
    assert.equal(isInvalidFriendAccessError(timeout), false);
    assert.equal(isInvalidFriendAccessError(new Error('unknown')), false);
});

export {};
