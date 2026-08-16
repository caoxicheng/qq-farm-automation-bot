const assert = require('node:assert/strict');
const test = require('node:test');
const { createWorkerApiHandler, createWorkerApiMethods } = require('../src/runtime/worker-api');
const {
    createWorkerAutomationScheduler,
    randomIntervalMs,
} = require('../src/runtime/worker-automation-scheduler');
const { buildDailyGiftOverview } = require('../src/runtime/worker-daily-gifts');
const { buildNextChecks, createWorkerStatusSynchronizer } = require('../src/runtime/worker-status-sync');

test('Worker API 调度器统一返回成功、异常和未知方法响应', async () => {
    const responses = [];
    const handler = createWorkerApiHandler({
        echo: args => ({ value: args[0] }),
        fail: () => { throw new Error('boom'); },
    }, response => responses.push(response));

    await handler({ type: 'api_call', id: 1, method: 'echo', args: ['ok'] });
    await handler({ type: 'api_call', id: 2, method: 'fail', args: [] });
    await handler({ type: 'api_call', id: 3, method: 'missing', args: [] });
    await handler({ type: 'api_call', id: 4, method: 'toString', args: [] });

    assert.deepEqual(responses, [
        { type: 'api_response', id: 1, result: { value: 'ok' }, error: undefined },
        { type: 'api_response', id: 2, result: null, error: 'boom' },
        { type: 'api_response', id: 3, result: null, error: 'Unknown method' },
        { type: 'api_response', id: 4, result: null, error: 'Unknown method' },
    ]);
});

test('Worker 默认 API 方法表保持与主进程调用契约一致', () => {
    const methods = createWorkerApiMethods({
        applyRuntimeConfig() {},
        getDailyGiftOverview() { return {}; },
    });

    assert.deepEqual(Object.keys(methods), [
        'getLands',
        'getFriends',
        'clearFriendsCache',
        'getInteractRecords',
        'getFriendLands',
        'doFriendOp',
        'getSeeds',
        'getBag',
        'getBagSeeds',
        'getDiamondBalance',
        'useItem',
        'sellItems',
        'setAutomation',
        'doFarmOp',
        'buyFertilizer',
        'checkAndBuyFertilizer',
        'getAnalytics',
        'getDailyGiftOverview',
        'getSchedulers',
        'getActivityCenterSnapshot',
        'getCurrentSeasonEvent',
        'getCurrentStarSandShop',
        'getCurrentSolarTerms',
        'getCurrentQingMeiActivity',
        'claimBattlePassRewards',
        'exchangeStarSandGoods',
        'lightConstellation',
        'claimSolarTerm',
        'claimQingMeiDailySeed',
        'startQingMeiBrew',
        'continueQingMeiBrew',
        'settleQingMeiBrew',
    ]);
});

test('每日礼包视图规范化任务进度和可选状态', () => {
    const overview = buildDailyGiftOverview({
        auto: { task: true },
        date: '2026-08-15',
        task: { doneToday: true, lastClaimAt: 10, completedCount: 2 },
        growthTask: { doneToday: false, completedCount: 1, totalCount: 4, tasks: [{ id: 1 }] },
        email: { doneToday: true, lastCheckAt: 20 },
        free: {},
        share: {},
        vip: { hasGift: false, canClaim: true, lastCheckAt: 30 },
        month: { hasCard: true, hasClaimable: false, result: 'claimed' },
    });

    assert.equal(overview.date, '2026-08-15');
    assert.deepEqual(overview.growth, {
        key: 'growth_task',
        label: '成长任务',
        doneToday: false,
        completedCount: 1,
        totalCount: 4,
        tasks: [{ id: 1 }],
    });
    assert.equal(overview.gifts[0].enabled, true);
    assert.equal(overview.gifts[0].totalCount, 3);
    assert.equal(overview.gifts[4].canClaim, true);
    assert.equal(overview.gifts[5].hasClaimable, false);
});

test('自动巡查调度器按秒级区间取值并串行触发到期任务', async () => {
    assert.equal(randomIntervalMs(2000, 4000, () => 0), 2000);
    assert.equal(randomIntervalMs(2000, 4000, () => 0.999), 4000);

    let now = 1000;
    let scheduledTask = null;
    let farmRuns = 0;
    const scheduler = {
        clear() { return true; },
        clearAll() {},
        getSnapshot() { return {}; },
        getTaskNames() { return []; },
        has() { return false; },
        setIntervalTask() { return {} as NodeJS.Timeout; },
        setTimeoutTask(_name, _delay, task) {
            scheduledTask = task;
            return {} as NodeJS.Timeout;
        },
    };
    const runtime = createWorkerAutomationScheduler({
        checkAndClaimEmails() {},
        checkAndClaimTasks() {},
        async checkFarm() { farmRuns += 1; },
        checkFriends() {},
        config: {
            farmCheckIntervalMin: 1000,
            farmCheckIntervalMax: 1000,
            helpCheckIntervalMin: 1000,
            helpCheckIntervalMax: 1000,
            stealCheckIntervalMin: 1000,
            stealCheckIntervalMax: 1000,
        },
        getAutomation: () => ({ farm: true }),
        isHelpExpLimitReached: () => false,
        isLoginReady: () => true,
        log() {},
        now: () => now,
        openFertilizerGiftPacksSilently() {},
        random: () => 0,
        scheduler,
    });

    runtime.start();
    assert.deepEqual(runtime.getScheduleTimes(), { farm: 2000, help: 2000, steal: 2000 });
    now = 2000;
    await scheduledTask();
    assert.equal(farmRuns, 1);
    assert.equal(runtime.getScheduleTimes().farm, 3000);
});

interface AutomationFixtureOptions {
    automation?: Record<string, boolean>;
    helpError?: boolean;
    helpExpLimitReached?: boolean;
    loginReady?: boolean;
}

function createAutomationFixture(options: AutomationFixtureOptions = {}) {
    let now = 1000;
    let scheduledTask = null;
    let scheduleCount = 0;
    let clearCount = 0;
    const events = [];
    const logs = [];
    const automation = options.automation || {};
    const scheduler = {
        clear() {
            clearCount += 1;
            return true;
        },
        clearAll() {},
        getSnapshot() { return {}; },
        getTaskNames() { return []; },
        has() { return false; },
        setIntervalTask() { return {} as NodeJS.Timeout; },
        setTimeoutTask(_name, _delay, task) {
            scheduleCount += 1;
            scheduledTask = task;
            return {} as NodeJS.Timeout;
        },
    };
    const runtime = createWorkerAutomationScheduler({
        async checkAndClaimEmails() { events.push('email'); },
        async checkAndClaimTasks() { events.push('task'); },
        async checkFarm() { events.push('farm'); },
        async checkFriends(friendOptions) {
            const event = friendOptions.onlyHelp ? 'help' : 'steal';
            events.push(event);
            if (event === 'help' && options.helpError) throw new Error('help failed');
        },
        config: {
            farmCheckIntervalMin: 1000,
            farmCheckIntervalMax: 1000,
            helpCheckIntervalMin: 1000,
            helpCheckIntervalMax: 1000,
            stealCheckIntervalMin: 1000,
            stealCheckIntervalMax: 1000,
        },
        getAutomation: () => automation,
        isHelpExpLimitReached: () => !!options.helpExpLimitReached,
        isLoginReady: () => options.loginReady !== false,
        log: (...args) => logs.push(args),
        now: () => now,
        async openFertilizerGiftPacksSilently() { events.push('fertilizer'); },
        random: () => 0,
        scheduler,
    });
    return {
        events,
        getClearCount: () => clearCount,
        getScheduleCount: () => scheduleCount,
        logs,
        runScheduled: async () => {
            assert.equal(typeof scheduledTask, 'function');
            await scheduledTask();
        },
        runtime,
        setNow(value) { now = value; },
    };
}

test('自动巡查同时到期时按农场、帮助、偷菜顺序串行执行', async () => {
    const fixture = createAutomationFixture({
        automation: {
            farm: true,
            task: true,
            email: true,
            fertilizer_gift: true,
            friend_help: true,
            friend_steal: true,
        },
    });

    fixture.runtime.start();
    fixture.setNow(2000);
    await fixture.runScheduled();

    assert.deepEqual(fixture.events, ['farm', 'task', 'email', 'fertilizer', 'help', 'steal']);
    assert.equal(fixture.getScheduleCount(), 2);
});

test('帮助经验满额时跳过巡查并推进下次时间，重复启停保持安全', async () => {
    const fixture = createAutomationFixture({
        automation: { friend_help: true, friend_help_exp_limit: true },
        helpExpLimitReached: true,
    });

    fixture.runtime.start();
    fixture.runtime.start();
    assert.equal(fixture.getScheduleCount(), 1);
    fixture.setNow(2000);
    await fixture.runScheduled();

    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.runtime.getScheduleTimes().help, 3000);
    fixture.runtime.stop();
    fixture.runtime.stop();
    assert.equal(fixture.getScheduleCount(), 2);
    assert.equal(fixture.getClearCount(), 4);
});

test('帮助巡查失败会记录错误并继续安排下一轮', async () => {
    const fixture = createAutomationFixture({
        automation: { friend_help: true },
        helpError: true,
    });

    fixture.runtime.start();
    fixture.setNow(2000);
    await fixture.runScheduled();

    assert.deepEqual(fixture.events, ['help']);
    assert.equal(fixture.logs.length, 1);
    assert.match(fixture.logs[0][1], /help failed/);
    assert.equal(fixture.runtime.getScheduleTimes().help, 3000);
    assert.equal(fixture.getScheduleCount(), 2);
});

test('状态倒计时对过期任务归零并合并好友巡查时间', () => {
    assert.deepEqual(buildNextChecks({ farm: 5000, help: 9000, steal: 7000 }, 6000), {
        farmRemainSec: 0,
        helpRemainSec: 3,
        stealRemainSec: 1,
        friendRemainSec: 3,
    });
});

test('状态同步在内容不变时去重，变化或超过心跳时间后重新发送', () => {
    let canSend = true;
    let now = 1000;
    let value = 1;
    let buildCount = 0;
    const messages = [];
    const syncStatus = createWorkerStatusSynchronizer({
        buildBaseStatus() {
            buildCount += 1;
            return { stats: { value }, levelProgress: null };
        },
        canSend: () => canSend,
        getAutomationState: () => ({ farm: true }),
        getConfigRevision: () => 7,
        getLoginReady: () => true,
        getPreferredSeedValue: () => 20001,
        getScheduleTimes: () => ({ farm: 0, help: 0, steal: 0 }),
        heartbeatMs: 8000,
        now: () => now,
        sendToMaster: message => messages.push(message),
    });

    syncStatus();
    syncStatus();
    assert.equal(messages.length, 1);

    now = 9001;
    syncStatus();
    assert.equal(messages.length, 2);

    value = 2;
    syncStatus();
    assert.equal(messages.length, 3);
    assert.equal(messages[2].data.value, 2);

    canSend = false;
    value = 3;
    syncStatus();
    assert.equal(messages.length, 3);
    assert.equal(buildCount, 4);
});

export {};
