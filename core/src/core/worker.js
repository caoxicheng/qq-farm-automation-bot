const process = require('node:process');
/**
 * 子进程 Worker - 负责运行单个账号的挂机逻辑
 */
const { parentPort, workerData } = require('node:worker_threads');
const { CONFIG } = require('../config/config');
const { getLevelExpProgress } = require('../config/gameConfig');
const { getAutomation, getPreferredSeed, getConfigSnapshot, applyConfigSnapshot } = require('../models/store');
const { checkAndClaimEmails } = require('../services/email');
const { getEmailDailyState } = require('../services/email');
const { checkFarm, startFarmCheckLoop, stopFarmCheckLoop, refreshFarmCheckLoop, getLandsDetail, getAvailableSeeds, runFarmOperation, runFertilizerByConfig } = require('../services/farm');
const { checkFriends, startFriendCheckLoop, stopFriendCheckLoop, refreshFriendCheckLoop, runBadOnceOnStartup, isHelpExpLimitReached, getFriendsList, getFriendLandsDetail, doFriendOperation } = require('../services/friend');
const { getInteractRecords } = require('../services/interact');
const { processInviteCodes } = require('../services/invite');
const { autoBuyFertilizer, checkAndBuyFertilizerBoth, buyFreeGifts, getFreeGiftDailyState } = require('../services/mall');
const { performDailyMonthCardGift, getMonthCardDailyState } = require('../services/monthcard');
const { performDailyVipGift, getVipDailyState } = require('../services/qqvip');
const { createScheduler, getSchedulerRegistrySnapshot } = require('../services/scheduler');
const { performDailyShare, getShareDailyState } = require('../services/share');
const { resetSessionGains, recordOperation, initStatsWithPersistence, saveStats } = require('../services/stats');
const { initStatusBar, setStatusPlatform, statusData } = require('../services/status');
const { setRecordGoldExpHook } = require('../services/status');
const { cleanupTaskSystem, checkAndClaimTasks, getTaskClaimDailyState, getTaskDailyStateLikeApp, getGrowthTaskStateLikeApp } = require('../services/task');
const { sellAllFruits, getBag, getBagItems, openFertilizerGiftPacksSilently } = require('../services/warehouse');
const { connect, reconnect, cleanup, getWs, getUserState, networkEvents } = require('../utils/network');
const { setClientVersionPrefix } = require('../config/config');
const { loadProto } = require('../utils/proto');
const { setLogHook, log, toNum } = require('../utils/utils');

if (parentPort && workerData && workerData.accountId && !process.env.FARM_ACCOUNT_ID) {
    process.env.FARM_ACCOUNT_ID = String(workerData.accountId);
}

// 应用主进程传入的版本前缀（服务端 version_info 校准结果，跨重启持久化）
if (process.env.FARM_VERSION_PREFIX) setClientVersionPrefix(process.env.FARM_VERSION_PREFIX);
if (workerData && workerData.versionPrefix) setClientVersionPrefix(workerData.versionPrefix);

function sendToMaster(payload) {
    if (process.send) {
        process.send(payload);
        return;
    }
    if (parentPort) {
        parentPort.postMessage(payload);
    }
}

function onMasterMessage(handler) {
    if (process.send) {
        process.on('message', handler);
    }
    if (parentPort) {
        parentPort.on('message', handler);
    }
}

function exitWorker(code = 0) {
    if (parentPort) {
        try {
            parentPort.close();
        } catch {}
        return;
    }
    process.exit(code);
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatLocalDateTime24(date = new Date()) {
    const d = date instanceof Date ? date : new Date();
    const y = d.getFullYear();
    const m = pad2(d.getMonth() + 1);
    const day = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

// 捕获日志发送给主进程
setLogHook((tag, msg, isWarn, meta) => {
    sendToMaster({
        type: 'log',
        data: {
            time: formatLocalDateTime24(new Date()),
            tag,
            msg,
            isWarn,
            meta: meta || {},
        }
    });
});

// 捕获金币经验变化
setRecordGoldExpHook((gold, exp) => {
    // 更新内部统计
    const { recordGoldExp } = require('../services/stats');
    recordGoldExp(gold, exp);

    // 发送给主进程
    sendToMaster({ type: 'stat_update', data: { gold, exp } });
});

let isRunning = false;
let loginReady = false;
let appliedConfigRevision = 0;
let unifiedSchedulerRunning = false;
let farmTaskRunning = false;
let nextFarmRunAt = 0;
let lastStatusHash = '';
let lastStatusSentAt = 0;
let onSellGain = null;
let onFarmHarvested = null;
let harvestSellRunning = false;
let onWsError = null;
let wsErrorHandledAt = 0;
let lastDailyRunDate = '';
const workerScheduler = createScheduler('worker');

function isDailyRoutineEnabled(_auto) {
    // 每日任务默认启用，不再检查开关
    return true;
}

function getLocalDateKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

async function runDailyRoutines(force = false) {
    if (!loginReady) return;
    try {
        // 以下功能默认启用，不再检查开关
        await checkAndClaimEmails(force);
        await performDailyShare(force);
        await performDailyMonthCardGift(force);
        await buyFreeGifts(force);
        await performDailyVipGift(force);
    } catch (e) {
        log('系统', `每日任务调度失败: ${e.message}`, { module: 'system', event: '每日任务', result: 'error' });
    }
}

function stopDailyRoutineTimer() {
    workerScheduler.clear('daily_routine_interval');
}

function startDailyRoutineTimer() {
    stopDailyRoutineTimer();
    lastDailyRunDate = getLocalDateKey();
    // 新账号登录后按当前设置强制执行一次领取
    runDailyRoutines(true).catch(() => null);
    workerScheduler.setIntervalTask('daily_routine_interval', 30 * 1000, () => {
        if (!loginReady) return;
        const today = getLocalDateKey();
        if (today === lastDailyRunDate) return;
        lastDailyRunDate = today;
        runDailyRoutines(true).catch(() => null);
    });
}

function normalizeIntervalRangeSec(minSec, maxSec, fallbackSec) {
    const fallback = Math.max(1, Number.parseInt(fallbackSec, 10) || 1);
    let min = Math.max(1, Number.parseInt(minSec, 10) || fallback);
    let max = Math.max(1, Number.parseInt(maxSec, 10) || fallback);
    if (min > max) [min, max] = [max, min];
    return { min, max };
}

function applyIntervalsToRuntime(intervals) {
    const data = (intervals && typeof intervals === 'object') ? intervals : {};

    const farmLegacy = Math.max(1, Number.parseInt(data.farm, 10) || 2);
    const farmRange = normalizeIntervalRangeSec(data.farmMin, data.farmMax, farmLegacy);
    CONFIG.farmCheckIntervalMin = farmRange.min * 1000;
    CONFIG.farmCheckIntervalMax = farmRange.max * 1000;
    CONFIG.farmCheckInterval = CONFIG.farmCheckIntervalMin;

    // 帮助和偷菜的独立间隔
    const helpRange = normalizeIntervalRangeSec(data.helpMin, data.helpMax, 10);
    CONFIG.helpCheckIntervalMin = helpRange.min * 1000;
    CONFIG.helpCheckIntervalMax = helpRange.max * 1000;

    const stealRange = normalizeIntervalRangeSec(data.stealMin, data.stealMax, 10);
    CONFIG.stealCheckIntervalMin = stealRange.min * 1000;
    CONFIG.stealCheckIntervalMax = stealRange.max * 1000;
}

function randomIntervalMs(minMs, maxMs) {
    const minSec = Math.max(1, Math.floor(Math.max(1000, Number(minMs) || 1000) / 1000));
    const maxSec = Math.max(minSec, Math.floor(Math.max(1000, Number(maxMs) || minSec * 1000) / 1000));
    if (maxSec === minSec) return minSec * 1000;
    const sec = minSec + Math.floor(Math.random() * (maxSec - minSec + 1));
    return sec * 1000;
}

function resetUnifiedSchedule() {
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    const helpMs = randomIntervalMs(
        CONFIG.helpCheckIntervalMin || 10000,
        CONFIG.helpCheckIntervalMax || 10000
    );
    const stealMs = randomIntervalMs(
        CONFIG.stealCheckIntervalMin || 10000,
        CONFIG.stealCheckIntervalMax || 10000
    );
    const now = Date.now();
    nextFarmRunAt = now + farmMs;
    nextHelpRunAt = now + helpMs;
    nextStealRunAt = now + stealMs;
}

async function runFarmTick(auto) {
    if (farmTaskRunning) return;
    farmTaskRunning = true;
    const farmMs = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 2000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 2000
    );
    try {
        if (auto.farm) await checkFarm();
        if (auto.task) await checkAndClaimTasks();
        if (auto.email) await checkAndClaimEmails();
        if (auto.fertilizer_gift) await openFertilizerGiftPacksSilently();
    } catch {
        // ignore
    } finally {
        nextFarmRunAt = Date.now() + farmMs;
        farmTaskRunning = false;
    }
}

// ============ 帮助巡查（独立调度） ============
let helpTaskRunning = false;
let nextHelpRunAt = 0;

async function runHelpTick(auto) {
    if (helpTaskRunning) {
        return;
    }
    if (!auto.friend_help) {
        return;
    }
    // 检查是否开启了经验满不帮忙，且经验已达上限
    const stopWhenExpLimit = !!auto.friend_help_exp_limit;
    if (stopWhenExpLimit && isHelpExpLimitReached()) {
        // 计算下次调度时间，但不执行巡查
        const helpMs = randomIntervalMs(
            CONFIG.helpCheckIntervalMin || 10000,
            CONFIG.helpCheckIntervalMax || 10000
        );
        nextHelpRunAt = Date.now() + helpMs;
        return;
    }
    helpTaskRunning = true;
    const helpMs = randomIntervalMs(
        CONFIG.helpCheckIntervalMin || 10000,
        CONFIG.helpCheckIntervalMax || 10000
    );
    //log('系统', `帮助巡查开始执行，下次间隔 ${helpMs}ms`, { module: 'system', event: '帮助巡查', result: 'start', intervalMs: helpMs });
    try {
        await checkFriends({ onlyHelp: true });
    } catch (e) {
        log('系统', `帮助巡查执行失败: ${e.message}`, { module: 'system', event: '帮助巡查', result: 'error' });
    } finally {
        nextHelpRunAt = Date.now() + helpMs;
        helpTaskRunning = false;
       // log('系统', `帮助巡查执行完成，下次执行时间: ${new Date(nextHelpRunAt).toISOString()}`, { module: 'system', event: '帮助巡查', result: 'done', nextRunAt: nextHelpRunAt });
    }
}

// ============ 偷菜巡查（独立调度） ============
let stealTaskRunning = false;
let nextStealRunAt = 0;

async function runStealTick(auto) {
    if (stealTaskRunning) {
        //log('系统', '偷菜巡查跳过：正在执行中', { module: 'system', event: '偷菜巡查', result: 'skipped', reason: 'running' });
        return;
    }
    if (!auto.friend_steal) {
       // log('系统', '偷菜巡查跳过：功能未开启', { module: 'system', event: '偷菜巡查', result: 'skipped', reason: 'disabled' });
        return;
    }
    stealTaskRunning = true;
    const stealMs = randomIntervalMs(
        CONFIG.stealCheckIntervalMin || 10000,
        CONFIG.stealCheckIntervalMax || 10000
    );
    try {
        await checkFriends({ onlySteal: true });
    } catch (e) {
        log('系统', `偷菜巡查执行失败: ${e.message}`, { module: 'system', event: '偷菜巡查', result: 'error' });
    } finally {
        nextStealRunAt = Date.now() + stealMs;
        stealTaskRunning = false;
    }
}

async function runUnifiedTick() {
    if (!unifiedSchedulerRunning || !loginReady) return;
    const now = Date.now();
    const dueFarm = now >= nextFarmRunAt;
    const dueHelp = now >= nextHelpRunAt;
    const dueSteal = now >= nextStealRunAt;
    if (!dueFarm && !dueHelp && !dueSteal) return;

    const auto = getAutomation();
    // 串行执行而非并行，避免并发请求过多导致超时
    if (dueFarm) await runFarmTick(auto);
    if (dueHelp) await runHelpTick(auto);
    if (dueSteal) await runStealTick(auto);
}

function scheduleUnifiedNextTick() {
    if (!unifiedSchedulerRunning) return;
    workerScheduler.clear('unified_next_tick');
    if (!loginReady) return;

    const now = Date.now();
    const nextAt = Math.min(
        Number(nextFarmRunAt) || (now + 1000),
        Number(nextHelpRunAt) || (now + 1000),
        Number(nextStealRunAt) || (now + 1000)
    );
    const delayMs = Math.max(1000, nextAt - now); // 最低 1 秒

    workerScheduler.setTimeoutTask('unified_next_tick', delayMs, async () => {
        try {
            await runUnifiedTick();
        } finally {
            scheduleUnifiedNextTick();
        }
    });
}

function startUnifiedScheduler() {
    if (unifiedSchedulerRunning) return;
    unifiedSchedulerRunning = true;
    resetUnifiedSchedule();
    scheduleUnifiedNextTick();
}

function stopUnifiedScheduler() {
    unifiedSchedulerRunning = false;
    farmTaskRunning = false;
    helpTaskRunning = false;
    stealTaskRunning = false;
    workerScheduler.clear('unified_next_tick');
}

function applyRuntimeConfig(snapshot, syncNow = false) {
    const prevAuto = getAutomation();
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    applyConfigSnapshot(snapshot || {}, { persist: false, accountId });
    const rev = Number((snapshot || {}).__revision || 0);
    if (rev > 0) appliedConfigRevision = rev;

    // 优先使用本次下发的间隔，避免 worker 内部 store 漂移导致回退默认值
    const incomingIntervals = (snapshot && snapshot.intervals && typeof snapshot.intervals === 'object')
        ? snapshot.intervals
        : null;
    if (incomingIntervals) {
        applyIntervalsToRuntime(incomingIntervals);
    }

    if (loginReady) {
        refreshFarmCheckLoop(200);
        refreshFriendCheckLoop(200);
        resetUnifiedSchedule();
        scheduleUnifiedNextTick();

        // 保存设置后若“自动处理日常”开启，则立即执行一次
        const hasAutomationPayload = !!(snapshot && snapshot.automation && typeof snapshot.automation === 'object');
        if (hasAutomationPayload) {
            const nextAuto = getAutomation();
            const wasEnabled = isDailyRoutineEnabled(prevAuto);
            const nowEnabled = isDailyRoutineEnabled(nextAuto);
            if (!wasEnabled && nowEnabled) {
                // 保存设置时 /api/automation 可能触发多次 config_sync，这里做防抖且仅关->开触发
                workerScheduler.setTimeoutTask('daily_routine_immediate', 400, () => {
                    runDailyRoutines(true).catch(() => null);
                });
            }

            const prevFertilizerMode = String(prevAuto && prevAuto.fertilizer ? prevAuto.fertilizer : '').toLowerCase();
            const nextFertilizerMode = String(nextAuto && nextAuto.fertilizer ? nextAuto.fertilizer : '').toLowerCase();
            const fertilizerChanged = prevFertilizerMode !== nextFertilizerMode;
            // if (fertilizerChanged && (nextFertilizerMode === 'both' || nextFertilizerMode === 'organic')) {
            if (fertilizerChanged && (nextFertilizerMode === 'both' || nextFertilizerMode === 'organic' || nextFertilizerMode === 'smart')) {
                // 保存设置时 /api/automation 可能连续触发多次 config_sync，这里做防抖为一次立即施肥
                workerScheduler.setTimeoutTask('fertilizer_immediate_after_save', 600, async () => {
                    if (!loginReady) return;
                    try {
                        // await runFertilizerByConfig([]);
                        await runFertilizerByConfig([], { skipNormal: true });
                    } catch (e) {
                        log('施肥', `保存配置后立即施肥失败: ${e.message}`, {
                            module: 'farm',
                            event: '施肥',
                            result: 'error',
                        });
                    }
                });
            }
        }
    }

    if (syncNow) syncStatus();
}

// 接收主进程指令
onMasterMessage(async (msg) => {
    try {
        if (msg.type === 'start') {
            await startBot(msg.config);
        } else if (msg.type === 'stop') {
            await stopBot();
        } else if (msg.type === 'api_call') {
            handleApiCall(msg);
        } else if (msg.type === 'config_sync') {
            applyRuntimeConfig(msg.config || {}, true);
        }
    } catch (e) {
        sendToMaster({ type: 'error', error: e.message });
    }
});

async function startBot(config) {
    if (isRunning) return;
    isRunning = true;

    const { code, platform } = config;

    CONFIG.platform = platform || 'qq';
    // 注意：间隔配置由 applyIntervalsToRuntime 统一处理，不要在这里覆盖

    await loadProto();

    log('系统', '正在连接服务器...');

    // 加载保存的配置
    applyRuntimeConfig(getConfigSnapshot(), false);

    initStatusBar();
    setStatusPlatform(CONFIG.platform);

    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    onWsError = (payload) => {
        if ((Number(payload?.code) || 0) !== 400) return;
        const now = Date.now();
        if (now - wsErrorHandledAt < 4000) return;
        wsErrorHandledAt = now;
        log('系统', '连接被拒绝，可能需要更新 Code');
        sendToMaster({
            type: 'ws_error',
            code: 400,
            message: payload?.message || '',
        });
        if (isRunning) {
            workerScheduler.setTimeoutTask('ws_error_cleanup', 1000, () => {
                if (isRunning) cleanup();
            });
        }
    };
    networkEvents.on('ws_error', onWsError);
    networkEvents.on('mallNeedNotify', () => {
        // 神秘商人/活动商店已由活动中心（activitypb 星砂商店）覆盖，mallpb 探测冗余，已停用
        // probeMallSlots().catch(() => {});
    });
    networkEvents.on('ws_code_rejected', async () => {
        // 连接被拒（400，登录 code 过期）：刷新微信 code 后重连，避免旧 code 死循环
        try {
            const { getAccounts, addOrUpdateAccount } = require('../models/store');
            const accountId = String(process.env.FARM_ACCOUNT_ID || '');
            const accounts = typeof getAccounts === 'function' ? getAccounts() : { accounts: [] };
            const acc = (accounts.accounts || []).find((a) => String(a.id) === accountId);
            if (!acc || !acc.wxid) {
                log('系统', '刷新 code 失败：找不到当前账号 wxid，5 秒后用旧 code 重连');
                workerScheduler.setTimeoutTask('season_ws_retry_old_code', 5000, () => reconnect(null));
                return;
            }
            const { getFarmCode } = require('../services/yyb-proxy');
            const refresh = await getFarmCode(acc.wxid);
            if (refresh.Success && refresh.Data && refresh.Data.code) {
                if (typeof addOrUpdateAccount === 'function') {
                    addOrUpdateAccount({ id: acc.id, code: refresh.Data.code });
                }
                log('系统', `账号 ${acc.name} 登录 code 已刷新，重新连接`, { accountId: String(accountId) });
                reconnect(refresh.Data.code);
            } else {
                log('系统', `账号 ${acc.name} 刷新 code 失败: ${refresh.Message || '未知'}，5 秒后用旧 code 重连`, { accountId: String(accountId) });
                workerScheduler.setTimeoutTask('season_ws_retry_old_code', 5000, () => reconnect(null));
            }
        } catch (e) {
            log('系统', `刷新 code 异常: ${e.message}，5 秒后用旧 code 重连`, { accountId: String(process.env.FARM_ACCOUNT_ID || '') });
            workerScheduler.setTimeoutTask('season_ws_retry_old_code', 5000, () => reconnect(null));
        }
    });

    networkEvents.on('kickout', onKickout);

    // 服务端版本前缀校准结果上报主进程（用于持久化，跨重启生效）
    networkEvents.on('versionPrefixChanged', (prefix) => {
        sendToMaster({ type: 'version_prefix_update', prefix });
    });

    const onLoginSuccess = async () => {
        loginReady = true;
        if (onSellGain) {
            networkEvents.off('sell', onSellGain);
        }
        onSellGain = (deltaGold) => {
            const delta = Number(deltaGold || 0);
            if (!Number.isFinite(delta) || delta <= 0) return;
            recordOperation('sell', 1);
        };
        networkEvents.on('sell', onSellGain);

        if (onFarmHarvested) {
            networkEvents.off('farmHarvested', onFarmHarvested);
        }
        onFarmHarvested = async () => {
            if (harvestSellRunning) return;
            if (!getAutomation().sell) return;
            harvestSellRunning = true;
            try {
                await sellAllFruits();
            } catch (e) {
                log('仓库', `收获后自动出售失败: ${e.message}`, { module: 'warehouse', event: '收获后出售', result: 'error' });
            } finally {
                harvestSellRunning = false;
            }
        };
        networkEvents.on('farmHarvested', onFarmHarvested);

        // 登录后主动拉一次背包，初始化点券(ID:1002)数量
        try {
            const bagReply = await getBag();
            const items = getBagItems(bagReply);
            let coupon = 0;
            for (const it of (items || [])) {
                if (toNum(it && it.id) === 1002) {
                    coupon = toNum(it.count);
                    break;
                }
            }
            const state = getUserState();
            state.coupon = Math.max(0, coupon);
        } catch {
            // ignore
        }
        // 登录成功后，以当前金币/经验/点券作为统计基线，并清空会话增量
        const latest = getUserState();
        const accountId = process.env.FARM_ACCOUNT_ID || '';
        initStatsWithPersistence(accountId, Number(latest.gold || 0), Number(latest.exp || 0), Number(latest.coupon || 0));
        resetSessionGains();

        // 登录成功后启动各模块
        await processInviteCodes();
        if (getAutomation().fertilizer_gift) {
            await openFertilizerGiftPacksSilently().catch(() => 0);
        }
        
        // 启动时执行一次放虫放草（只在账号启动时执行）
        workerScheduler.setTimeoutTask('bad_startup_once', 10000, async () => {
            try {
                await runBadOnceOnStartup();
            } catch (e) {
                log('好友', `启动时放虫放草执行失败: ${e.message}`, { module: 'friend', event: '启动放虫放草失败', error: e.message });
            }
        });
        
        startFarmCheckLoop({ externalScheduler: true });
        startFriendCheckLoop({ externalScheduler: true });
        startUnifiedScheduler();
        // 每日礼包/任务改为跨日调度，不在农场轮询内执行
        startDailyRoutineTimer();

        // 立即发送一次状态
        syncStatus();
    };

    connect(code, onLoginSuccess);

    // 启动定时状态同步
    workerScheduler.setIntervalTask('status_sync', 3000, syncStatus, { preventOverlap: true });
}

async function stopBot() {
    if (!isRunning) return exitWorker(0);
    saveStats();
    isRunning = false;
    loginReady = false;
    stopUnifiedScheduler();
    networkEvents.off('kickout', onKickout);
    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    if (onSellGain) {
        networkEvents.off('sell', onSellGain);
        onSellGain = null;
    }
    if (onFarmHarvested) {
        networkEvents.off('farmHarvested', onFarmHarvested);
        onFarmHarvested = null;
    }
    stopFarmCheckLoop();
    stopFriendCheckLoop();
    stopDailyRoutineTimer();
    cleanupTaskSystem();
    workerScheduler.clearAll();
    cleanup();
    const ws = getWs();
    if (ws) ws.close();
    exitWorker(0);
}

function onKickout(payload) {
    const reason = payload && payload.reason ? payload.reason : '未知';
    log('系统', `检测到踢下线，准备自动停止账号。原因: ${reason}`);
    sendToMaster({ type: 'account_kicked', reason });
    workerScheduler.setTimeoutTask('kickout_stop', 200, () => {
        stopBot().catch(() => exitWorker(0));
    });
}

// 处理来自 Admin 面板的直接调用请求 (如: 购买种子、开关设置等)
async function handleApiCall(msg) {
    const { id, method, args } = msg;
    let result = null;
    let error = null;

    try {
        switch (method) {
            case 'getLands':
                result = await getLandsDetail();
                break;
            case 'getFriends':
                result = await getFriendsList(args[0] === true);
                break;
            case 'clearFriendsCache':
                require('../services/friend').clearFriendsListCache();
                result = { ok: true };
                break;
            case 'getInteractRecords':
                result = await getInteractRecords();
                break;
            case 'getFriendLands':
                result = await getFriendLandsDetail(args[0]);
                break;
            case 'doFriendOp':
                result = await doFriendOperation(args[0], args[1]);
                break;
            case 'getSeeds':
                result = await getAvailableSeeds();
                break;
            case 'getBag':
                result = await require('../services/warehouse').getBagDetail();
                break;
            case 'getBagSeeds':
                result = await require('../services/warehouse').getBagSeeds();
                break;
            case 'useItem': {
                const { useItem: _useItem } = require('../services/warehouse');
                const itemId = Number(args[0]) || 0;
                const count = Math.max(1, Number(args[1]) || 1);
                result = await _useItem(itemId, count, []);
                break;
            }
            case 'sellItems': {
                const { sellItems: _sell } = require('../services/warehouse');
                const sellList = Array.isArray(args[0]) ? args[0] : [];
                result = await _sell(sellList.map(it => ({ id: it.id, count: it.count, uid: it.uid || 0 })));
                break;
            }
            case 'setAutomation': {
                const payload = args && args[0] ? args[0] : {};
                applyRuntimeConfig({ automation: { [payload.key]: payload.value } }, true);
                result = getAutomation();
                break;
            }
            case 'doFarmOp':
                result = await runFarmOperation(args[0]); // opType
                break;
            case 'buyFertilizer': {
                const fertilizerType = args[0] || 'organic';
                const fertilizerCount = Number(args[1]) || 0;
                result = await autoBuyFertilizer(true, fertilizerType, fertilizerCount);
                break;
            }
            case 'checkAndBuyFertilizer': {
                const options = args[0] || {};
                result = await checkAndBuyFertilizerBoth(options);
                break;
            }
            case 'getAnalytics': {
                const { getPlantRankings } = require('../services/analytics');
                result = getPlantRankings(args[0]); // sortBy
                break;
            }
            case 'getDailyGiftOverview':
                result = await getDailyGiftOverview();
                break;
            case 'getSchedulers':
                result = getSchedulerRegistrySnapshot();
                break;
            // 活动中心（千星游记/观星/星砂商店/节令）
            case 'getActivityCenterSnapshot':
                result = await require('../services/activity').getActivityCenterSnapshot();
                break;
            // 神秘商人
            case 'getMysteryShop':
                result = await require('../services/mystery-shop').getMysteryShopSnapshot();
                break;
            case 'buyMysteryGoods':
                result = await require('../services/mystery-shop').buyMysteryGoods(args[0], args[1]);
                break;
            case 'getCurrentSeasonEvent':
                result = await require('../services/activity').getCurrentSeasonEvent();
                break;
            case 'getCurrentStarSandShop':
                result = await require('../services/activity').getCurrentStarSandShop();
                break;
            case 'getCurrentSolarTerms':
                result = await require('../services/activity').getCurrentSolarTerms();
                break;
            case 'claimBattlePassRewards':
                result = await require('../services/activity').claimBattlePassRewards();
                break;
            case 'exchangeStarSandGoods':
                result = await require('../services/activity').exchangeStarSandGoods(args[0], args[1]);
                break;
            case 'lightConstellation':
                result = await require('../services/activity').lightConstellation();
                break;
            case 'claimSolarTerm':
                result = await require('../services/activity').claimSolarTerm(args[0]);
                break;
            default:
                error = 'Unknown method';
        }
    } catch (e) {
        error = e.message;
    }

    sendToMaster({ type: 'api_response', id, result, error });
}

async function getDailyGiftOverview() {
    const auto = getAutomation() || {};
    const task = getTaskDailyStateLikeApp
        ? await getTaskDailyStateLikeApp()
        : (getTaskClaimDailyState ? getTaskClaimDailyState() : { doneToday: false, lastClaimAt: 0 });
    const growthTask = getGrowthTaskStateLikeApp
        ? await getGrowthTaskStateLikeApp()
        : { doneToday: false, completedCount: 0, totalCount: 0, tasks: [] };
    const email = getEmailDailyState ? getEmailDailyState() : { doneToday: false, lastCheckAt: 0 };
    const free = getFreeGiftDailyState ? getFreeGiftDailyState() : { doneToday: false, lastClaimAt: 0 };
    const share = getShareDailyState ? getShareDailyState() : { doneToday: false, lastClaimAt: 0 };
    const vip = getVipDailyState ? getVipDailyState() : { doneToday: false, lastClaimAt: 0 };
    const month = getMonthCardDailyState ? getMonthCardDailyState() : { doneToday: false, lastClaimAt: 0 };

    return {
        date: new Date().toISOString().slice(0, 10),
        growth: {
            key: 'growth_task',
            label: '成长任务',
            doneToday: !!growthTask.doneToday,
            completedCount: Number(growthTask.completedCount || 0),
            totalCount: Number(growthTask.totalCount || 0),
            tasks: Array.isArray(growthTask.tasks) ? growthTask.tasks : [],
        },
        gifts: [
            {
                key: 'task_claim',
                label: '每日任务',
                enabled: !!auto.task,
                doneToday: !!task.doneToday,
                lastAt: Number(task.lastClaimAt || 0),
                completedCount: Number(task.completedCount || 0),
                totalCount: Number(task.totalCount || 3),
            },
            // 以下功能默认启用，enabled 固定为 true
            { key: 'email_rewards', label: '邮箱奖励', enabled: true, doneToday: !!email.doneToday, lastAt: Number(email.lastCheckAt || 0) },
            { key: 'mall_free_gifts', label: '商城免费礼包', enabled: true, doneToday: !!free.doneToday, lastAt: Number(free.lastClaimAt || 0) },
            { key: 'daily_share', label: '分享礼包', enabled: true, doneToday: !!share.doneToday, lastAt: Number(share.lastClaimAt || 0) },
            {
                key: 'vip_daily_gift',
                label: '会员礼包',
                enabled: true,
                doneToday: !!vip.doneToday,
                lastAt: Number(vip.lastClaimAt || vip.lastCheckAt || 0),
                hasGift: Object.prototype.hasOwnProperty.call(vip, 'hasGift') ? !!vip.hasGift : undefined,
                canClaim: Object.prototype.hasOwnProperty.call(vip, 'canClaim') ? !!vip.canClaim : undefined,
                result: vip.result || '',
            },
            {
                key: 'month_card_gift',
                label: '月卡礼包',
                enabled: true,
                doneToday: !!month.doneToday,
                lastAt: Number(month.lastClaimAt || month.lastCheckAt || 0),
                hasCard: Object.prototype.hasOwnProperty.call(month, 'hasCard') ? !!month.hasCard : undefined,
                hasClaimable: Object.prototype.hasOwnProperty.call(month, 'hasClaimable') ? !!month.hasClaimable : undefined,
                result: month.result || '',
            },
        ],
    };
}

function syncStatus() {
    if (!process.send && !parentPort) return;

    const userState = getUserState();
    const ws = getWs();
    const connected = !!(loginReady && ws && ws.readyState === 1);

    let expProgress = null;
    const level = (userState.level ?? statusData.level ?? 0);
    const exp = (userState.exp ?? statusData.exp ?? 0);

    if (level > 0 && exp >= 0) {
        expProgress = getLevelExpProgress(level, exp);
    }

    const limits = require('../services/friend').getOperationLimits();
    const fullStats = require('../services/stats').getStats(statusData, userState, connected, limits);
    const nowMs = Date.now();
    const farmRemainSec = Math.max(0, Math.ceil((Number(nextFarmRunAt || 0) - nowMs) / 1000));
    const helpRemainSec = Math.max(0, Math.ceil((Number(nextHelpRunAt || 0) - nowMs) / 1000));
    const stealRemainSec = Math.max(0, Math.ceil((Number(nextStealRunAt || 0) - nowMs) / 1000));
    fullStats.nextChecks = {
        farmRemainSec,
        helpRemainSec,
        stealRemainSec,
        friendRemainSec: Math.max(helpRemainSec, stealRemainSec),
    };

    fullStats.automation = getAutomation();
    fullStats.preferredSeed = getPreferredSeed();
    fullStats.levelProgress = expProgress;
    fullStats.configRevision = appliedConfigRevision;
    const hash = JSON.stringify(fullStats);
    const now = Date.now();
    if (hash !== lastStatusHash || now - lastStatusSentAt > 8000) {
        lastStatusHash = hash;
        lastStatusSentAt = now;
        sendToMaster({ type: 'status_sync', data: fullStats });
    }
}