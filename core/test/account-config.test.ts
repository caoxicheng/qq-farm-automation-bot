const assert = require('node:assert/strict');
const test = require('node:test');
const {
    cloneAccountConfig,
    normalizeAccountConfig,
    normalizeOfflineReminder,
} = require('../src/models/account-config');

test('账号配置按白名单收窄并规范化区间、时间和列表', () => {
    const config = normalizeAccountConfig({
        automation: {
            farm: 0,
            fertilizer: 'invalid',
            fertilizer_land_types: ['RED', 'gold', 'red', 'invalid'],
            unknownFlag: true,
        },
        intervals: { farmMin: 30, farmMax: 10, helpMin: 40, helpMax: 20 },
        friendQuietHours: { enabled: 1, start: '27:90', end: '6:5' },
        autoRelogin: { enabled: 1, delayMinutes: 0, maxPerDay: 1000, loginFailWindowSec: 1 },
        bagSeedPriority: ['20001', 20001, -1, 'bad', 20002],
        friendBlacklist: ['123', 0, 'bad'],
    });

    assert.equal(config.automation.farm, false);
    assert.equal(config.automation.fertilizer, 'smart');
    assert.deepEqual(config.automation.fertilizer_land_types, ['red', 'gold']);
    assert.equal(Object.hasOwn(config.automation, 'unknownFlag'), false);
    assert.equal(config.intervals.farmMin, 10);
    assert.equal(config.intervals.farmMax, 30);
    assert.equal(config.intervals.helpMin, 20);
    assert.equal(config.intervals.helpMax, 40);
    assert.deepEqual(config.friendQuietHours, { enabled: true, start: '23:59', end: '06:05' });
    assert.equal(config.autoRelogin.delayMinutes, 1);
    assert.equal(config.autoRelogin.maxPerDay, 100);
    assert.equal(config.autoRelogin.loginFailWindowSec, 5);
    assert.deepEqual(config.bagSeedPriority, [20001, 20002]);
    assert.deepEqual(config.friendBlacklist, [123]);
});

test('默认账号配置克隆不会共享可变数组或嵌套对象', () => {
    const first = cloneAccountConfig();
    const second = cloneAccountConfig();
    first.friendBlacklist.push(123);
    first.bagSeedPriority.push(20001);
    first.automation.fertilizer_land_types.push('invalid');
    first.intervals.farm = 999;

    assert.deepEqual(second.friendBlacklist, []);
    assert.deepEqual(second.bagSeedPriority, []);
    assert.deepEqual(second.automation.fertilizer_land_types, ['gold', 'black', 'red', 'normal']);
    assert.equal(second.intervals.farm, 2);
});

test('旧版将推送渠道写入 endpoint 时继续完成兼容迁移', () => {
    const reminder = normalizeOfflineReminder({ endpoint: 'bark', title: '下线提醒' });
    assert.equal(reminder.channel, 'bark');
    assert.equal(reminder.endpoint, 'bark');
    assert.equal(reminder.title, '下线提醒');
});
export {};
