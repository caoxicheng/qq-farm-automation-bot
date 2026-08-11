/**
 * 好友农场操作 - 进入/离开/帮忙/偷菜/巡查
 */

const { CONFIG, PlantPhase, PHASE_NAMES } = require('../config/config');
const { getPlantName, getPlantById, getSeedImageBySeedId, getPlantGrowTime, deriveSeedIdFromPlantId } = require('../config/gameConfig');
const { parentPort } = require('node:worker_threads');
const crypto = require('node:crypto');
const { getDataFile } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');
const {
    isAutomationOn,
    getFriendQuietHours,
    getFriendBlacklist,
    getPlantBlacklist,
    getKnownFriendGids,
    getKnownFriendGidSyncCooldownSec,
    getFriendsListCacheTtlSec,
    applyConfigSnapshot,
} = require('../models/store');
const { sendMsgAsync, getUserState, networkEvents } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, toTimeSec, getServerTimeSec, log, logWarn, sleep, randomDelay } = require('../utils/utils');
const { getCurrentPhase, setOperationLimitsCallback, buildLandMap, getDisplayLandContext, isOccupiedSlaveLand } = require('./farm');
const { getInteractRecords } = require('./interact');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');
const { sellAllFruits } = require('./warehouse');

// ============ 内部状态 ============
let isCheckingFriends = false;
let friendLoopRunning = false;
let externalSchedulerMode = false;
let lastResetDate = '';  // 上次重置日期 (YYYY-MM-DD)
const friendScheduler = createScheduler('friend');

// 好友列表缓存
let friendsListCache = null;
let friendsListCacheTime = 0;

function getFriendsListCacheTtlMs() {
    const sec = Number(getFriendsListCacheTtlSec ? getFriendsListCacheTtlSec() : 0);
    if (!Number.isFinite(sec) || sec <= 0) return 60 * 1000;
    return Math.max(10 * 1000, sec * 1000);
}

const operationLimits = new Map();

// 捣乱共享额度：抓包确认放草/放虫都消耗 operation 10003（放虫额外报告 10004，共享每日额度是 10003）
const BAD_SHARED_LIMIT_ID = 10003;
const BAD_DAILY_STATE_VERSION = 1;
let badOperationLimitReached = false; // 当日捣蛋已停用（吃 1001046 或额度满后置位，跨日重置）

const QQ_FRIEND_LIST_BATCH_SIZE = 35;
const DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const MIN_QQ_VISITOR_GID_SYNC_RETRY_MS = 30 * 1000;
const MAX_QQ_VISITOR_GID_SYNC_RETRY_MS = 2 * 60 * 1000;
const INVALID_KNOWN_FRIEND_GID_COOLDOWN_MS = 24 * 60 * 60 * 1000;

let canGetHelpExp = true;
let helpAutoDisabledByLimit = false;
let lastVisitorGidSyncAt = 0;
const invalidKnownFriendGidCooldownUntil = new Map();
const OP_NAMES = {
    10001: '收获',
    10002: '铲除',
    10003: '放草',
    10004: '放虫',
    10005: '除草',
    10006: '除虫',
    10007: '浇水',
    10008: '偷菜',
};

function postToMaster(payload) {
    try {
        if (process.send) {
            process.send(payload);
            return true;
        }
        if (parentPort && typeof parentPort.postMessage === 'function') {
            parentPort.postMessage(payload);
            return true;
        }
    } catch {}
    return false;
}

function pruneInvalidKnownFriendGidCooldown(nowMs = Date.now()) {
    for (const [gid, until] of invalidKnownFriendGidCooldownUntil.entries()) {
        if (!gid || until <= nowMs) invalidKnownFriendGidCooldownUntil.delete(gid);
    }
}

function clearInvalidKnownFriendGidMarks(gids) {
    for (const gid of normalizeFriendGids(gids)) {
        invalidKnownFriendGidCooldownUntil.delete(gid);
    }
}

function markKnownFriendGidInvalid(friendGid, nowMs = Date.now()) {
    const gid = toNum(friendGid);
    if (!gid) return;
    invalidKnownFriendGidCooldownUntil.set(gid, nowMs + INVALID_KNOWN_FRIEND_GID_COOLDOWN_MS);
}

function getInvalidKnownFriendGidSet(nowMs = Date.now()) {
    pruneInvalidKnownFriendGidCooldown(nowMs);
    return new Set(invalidKnownFriendGidCooldownUntil.keys());
}

function getKnownFriendGidSyncIntervalMs() {
    const sec = Number(getKnownFriendGidSyncCooldownSec ? getKnownFriendGidSyncCooldownSec() : 0);
    if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS;
    return Math.max(30 * 1000, sec * 1000);
}

function getKnownFriendGidSyncRetryMs() {
    const intervalMs = getKnownFriendGidSyncIntervalMs();
    return Math.max(MIN_QQ_VISITOR_GID_SYNC_RETRY_MS, Math.min(intervalMs, MAX_QQ_VISITOR_GID_SYNC_RETRY_MS));
}

function normalizeFriendGids(values) {
    const normalized = [];
    for (const item of (Array.isArray(values) ? values : [])) {
        const value = toNum(item);
        if (value <= 0) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

function extractReplyFriends(reply) {
    if (Array.isArray(reply && reply.game_friends)) return reply.game_friends;
    if (Array.isArray(reply && reply.gameFriends)) return reply.gameFriends;
    return [];
}

function dedupeFriendsByGid(friends) {
    const result = [];
    const seen = new Set();
    for (const friend of (Array.isArray(friends) ? friends : [])) {
        const gid = toNum(friend && friend.gid);
        if (gid <= 0 || seen.has(gid)) continue;
        seen.add(gid);
        result.push(friend);
    }
    return result;
}

function buildFriendReply(friends) {
    const list = dedupeFriendsByGid(friends);
    return {
        game_friends: list,
        gameFriends: list,
    };
}

function syncKnownFriendGidsFromFriends(friends) {
    const fetchedGids = normalizeFriendGids((Array.isArray(friends) ? friends : []).map(friend => friend && friend.gid));
    if (fetchedGids.length === 0) return [];

    clearInvalidKnownFriendGidMarks(fetchedGids);

    const current = normalizeFriendGids(getKnownFriendGids());
    const merged = normalizeFriendGids([...current, ...fetchedGids]);
    if (merged.length === current.length && merged.every((gid, index) => gid === current[index])) {
        return merged;
    }

    applyConfigSnapshot({ knownFriendGids: merged }, { persist: false });
    const sent = postToMaster({
        type: 'known_friend_gids_sync',
        gids: merged,
    });
    if (!sent) {
        applyConfigSnapshot({ knownFriendGids: merged }, { persist: true });
    }
    return merged;
}

function getEffectiveKnownQqFriendGids() {
    const currentKnownGids = normalizeFriendGids(getKnownFriendGids());
    clearInvalidKnownFriendGidMarks(currentKnownGids);
    const accountId = process.env.FARM_ACCOUNT_ID || '';

    const invalidGidSet = getInvalidKnownFriendGidSet();
    const blacklistSet = new Set(getFriendBlacklist(accountId));
    return normalizeFriendGids(currentKnownGids).filter(gid => !invalidGidSet.has(gid) && !blacklistSet.has(gid));
}

async function syncKnownFriendGidsFromRecentVisitors(force = false) {
    const now = Date.now();
    const interval = lastVisitorGidSyncAt > 0 ? getKnownFriendGidSyncIntervalMs() : 0;
    if (!force && interval > 0 && now - lastVisitorGidSyncAt < interval) {
        return getEffectiveKnownQqFriendGids();
    }

    const accountId = process.env.FARM_ACCOUNT_ID || '';

    try {
        const records = await getInteractRecords();
        const invalidGidSet = getInvalidKnownFriendGidSet(now);
        const visitorGids = normalizeFriendGids(
            (Array.isArray(records) ? records : []).map(record => record && record.visitorGid),
        ).filter(gid => !invalidGidSet.has(gid));
        lastVisitorGidSyncAt = now;

        if (visitorGids.length === 0) {
            return getEffectiveKnownQqFriendGids();
        }

        const merged = normalizeFriendGids([
            ...getKnownFriendGids(),
            ...visitorGids,
        ]);
        const current = normalizeFriendGids(getKnownFriendGids());
        const addedCount = merged.filter(gid => !current.includes(gid)).length;
        if (addedCount > 0) {
            applyConfigSnapshot({ knownFriendGids: merged }, { persist: false, accountId });
            const sent = postToMaster({
                type: 'known_friend_gids_sync',
                gids: merged,
            });
            if (!sent) {
                applyConfigSnapshot({ knownFriendGids: merged }, { persist: true, accountId });
            }
            log('好友', `已从最近访客自动补充 ${addedCount} 个 GID，当前已知好友 GID 共 ${merged.length} 个`, {
                module: 'friend',
                event: '访客补充好友GID',
                result: 'ok',
                addedFromVisitors: addedCount,
                totalKnownGids: merged.length,
            });
        }
        return normalizeFriendGids([
            ...merged,
            ...getFriendBlacklist(accountId),
        ]);
    } catch (e) {
        const retryMs = getKnownFriendGidSyncRetryMs();
        const intervalMs = getKnownFriendGidSyncIntervalMs();
        if (now - lastVisitorGidSyncAt >= retryMs) {
            lastVisitorGidSyncAt = now - (intervalMs - retryMs);
        }
        logWarn('好友', `同步最近访客 GID 失败: ${e.message}`, {
            module: 'friend',
            event: '同步好友GID',
            result: 'error',
        });
        return getEffectiveKnownQqFriendGids();
    }
}

function removeKnownFriendGid(friendGid, friendName, reason = '') {
    const gid = toNum(friendGid);
    if (!gid) return false;

    const current = normalizeFriendGids(getKnownFriendGids());
    const next = current.filter(item => item !== gid);
    markKnownFriendGidInvalid(gid);
    if (next.length !== current.length) {
        applyConfigSnapshot({ knownFriendGids: next }, { persist: false });
    }

    const sent = postToMaster({
        type: 'known_friend_gid_remove',
        gid,
        friendName: friendName || `GID:${gid}`,
        reason: String(reason || ''),
    });
    if (!sent && next.length !== current.length) {
        applyConfigSnapshot({ knownFriendGids: next }, { persist: true });
    }

    logWarn('好友', `检测到失效好友 GID，已自动移除: ${friendName || `GID:${gid}`}`, {
        module: 'friend',
        event: '检测失效好友GID',
        result: 'auto_removed',
        friendName: friendName || `GID:${gid}`,
        friendGid: gid,
        reason: String(reason || ''),
    });
    return true;
}

function isEnterFarmBannedError(error) {
    const message = String((error && error.message) || error || '');
    if (!message) return false;
    return message.includes('1002003');
}

function parseRpcErrorCode(error) {
    const message = String((error && error.message) || error || '');
    const match = message.match(/code=(\d+)/i);
    return match ? (Number.parseInt(match[1], 10) || 0) : 0;
}

function isTransientNetworkError(error) {
    const message = String((error && error.message) || error || '');
    if (!message) return false;
    return [
        '连接未打开',
        '请求超时',
        '请求已中断',
        '连接关闭',
        '连接已在加密途中关闭',
        'worker exited',
    ].some(keyword => message.includes(keyword));
}

function isInvalidFriendAccessError(error) {
    const message = String((error && error.message) || error || '');
    if (!message || isEnterFarmBannedError(error) || isTransientNetworkError(error)) {
        return false;
    }

    const lowerMessage = message.toLowerCase();
    const hasInvalidKeyword = [
        '无效',
        '不存在',
        '删除',
        '关系',
        'not found',
        'invalid',
        'not friend',
        'friend',
    ].some(keyword => lowerMessage.includes(keyword.toLowerCase()));

    return hasInvalidKeyword && parseRpcErrorCode(error) > 0;
}

function addFriendToBlacklist(friendGid, friendName, reason = '') {
    const gid = toNum(friendGid);
    if (!gid) return false;
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    const currentList = getFriendBlacklist(accountId);
    const current = Array.isArray(currentList) ? currentList : [];
    if (current.includes(gid)) return false;

    const sent = postToMaster({
        type: 'friend_blacklist_add',
        gid,
        friendName: friendName || `GID:${gid}`,
        reason: String(reason || ''),
    });
    if (!sent) return false;

    logWarn('好友', `检测到封禁好友，已自动加入黑名单: ${friendName || `GID:${gid}`}`, {
        module: 'friend',
        event: '加黑名单',
        result: 'auto_blocked',
        friendName: friendName || `GID:${gid}`,
        friendGid: gid,
        reason: String(reason || ''),
    });
    return true;
}

function handleFriendEnterError(friendGid, friendName, error) {
    const gid = toNum(friendGid);
    const displayName = String(friendName || '').trim() || `GID:${gid}`;
    const reason = String((error && error.message) || error || '');
    if (isEnterFarmBannedError(error)) {
        addFriendToBlacklist(gid, displayName, reason);
        return { handled: true, kind: 'blacklist' };
    }
    if (isInvalidFriendAccessError(error)) {
        removeKnownFriendGid(gid, displayName, reason);
        return { handled: true, kind: 'invalid_removed' };
    }
    return { handled: false, kind: 'error' };
}

async function fetchQqFriendsByKnownGids() {
    if (!types.GetGameFriendsRequest || !types.GetAllFriendsReply) {
        throw new Error('GetGameFriends 接口类型未加载');
    }

    const knownGids = getEffectiveKnownQqFriendGids();
    if (knownGids.length === 0) {
        return [];
    }

    const allFriends = [];
    for (let i = 0; i < knownGids.length; i += QQ_FRIEND_LIST_BATCH_SIZE) {
        const batch = knownGids.slice(i, i + QQ_FRIEND_LIST_BATCH_SIZE);
        const body = types.GetGameFriendsRequest.encode(types.GetGameFriendsRequest.create({
            gids: batch.map(gid => toLong(gid)),
        })).finish();
        try {
            const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetGameFriends', body);
            const reply = types.GetAllFriendsReply.decode(replyBody);
            allFriends.push(...extractReplyFriends(reply));
        } catch (e) {
            logWarn('好友', `QQ 新好友接口分批请求失败(${i + 1}-${i + batch.length}/${knownGids.length}): ${e.message}`, {
                module: 'friend',
                event: '好友列表接口',
                result: 'error',
                method: 'GetGameFriends',
                batchSize: batch.length,
            });
        }
        if (i + QQ_FRIEND_LIST_BATCH_SIZE < knownGids.length) {
            await randomDelay(500, 1000);
        }
    }

    return dedupeFriendsByGid(allFriends);
}

async function fetchQqFriendsByLegacyMethod() {
    const errors = [];

    try {
        const syncReq = types.SyncAllRequest || types.SyncAllFriendsRequest;
        const syncRep = types.SyncAllReply || types.SyncAllFriendsReply;
        if (!syncReq || !syncRep) throw new Error('SyncAll 接口类型未加载');
        const body = syncReq.encode(syncReq.create({ open_ids: [] })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'SyncAll', body);
        return extractReplyFriends(syncRep.decode(replyBody));
    } catch (e) {
        errors.push(`SyncAll: ${e.message}`);
    }

    try {
        if (!types.GetAllFriendsRequest || !types.GetAllFriendsReply) throw new Error('GetAll 接口类型未加载');
        const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body);
        return extractReplyFriends(types.GetAllFriendsReply.decode(replyBody));
    } catch (e) {
        errors.push(`GetAll: ${e.message}`);
    }

    throw new Error(errors.join(' | '));
}

function parseTimeToMinutes(timeStr) {
    const m = String(timeStr || '').match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return null;
    const h = Number.parseInt(m[1], 10);
    const min = Number.parseInt(m[2], 10);
    if (Number.isNaN(h) || Number.isNaN(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
}

function inFriendQuietHours(now = new Date()) {
    const cfg = getFriendQuietHours();
    if (!cfg || !cfg.enabled) return false;

    const start = parseTimeToMinutes(cfg.start);
    const end = parseTimeToMinutes(cfg.end);
    if (start === null || end === null) return false;

    const cur = now.getHours() * 60 + now.getMinutes();
    if (start === end) return true; // 起止相同视为全天静默
    if (start < end) return cur >= start && cur < end;
    return cur >= start || cur < end; // 跨天时段
}

// ============ 好友 API ============
async function getAllFriends(forceSync = false) {
    const isQQ = CONFIG.platform === 'qq';
    if (isQQ) {
        await syncKnownFriendGidsFromRecentVisitors(forceSync);
        const friendsFromKnownGids = await fetchQqFriendsByKnownGids();
        if (friendsFromKnownGids.length > 0) {
            syncKnownFriendGidsFromFriends(friendsFromKnownGids);
            return buildFriendReply(friendsFromKnownGids);
        }

        try {
            const legacyFriends = dedupeFriendsByGid(await fetchQqFriendsByLegacyMethod());
            if (legacyFriends.length > 0) {
                syncKnownFriendGidsFromFriends(legacyFriends);
            } else if (getEffectiveKnownQqFriendGids().length === 0) {
                logWarn('好友', 'QQ 好友列表为空；若近期接口已切到 GetGameFriends，请先在好友页维护已知好友 GID 列表', {
                    module: 'friend',
                    event: '好友列表接口',
                    result: 'empty',
                });
            }
            return buildFriendReply(legacyFriends);
        } catch (e) {
            if (getEffectiveKnownQqFriendGids().length === 0) {
                throw new Error(`QQ 好友列表获取失败，请先在好友页维护已知好友 GID 列表。${e.message}`);
            }
            throw e;
        }
    }

    const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body);
    return types.GetAllFriendsReply.decode(replyBody);
}

async function acceptFriends(gids) {
    const body = types.AcceptFriendsRequest.encode(types.AcceptFriendsRequest.create({
        friend_gids: gids.map(g => toLong(g)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'AcceptFriends', body);
    return types.AcceptFriendsReply.decode(replyBody);
}

async function enterFriendFarm(friendGid) {
    const body = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
        host_gid: toLong(friendGid),
        reason: 2,  // ENTER_REASON_FRIEND
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body);
    return types.VisitEnterReply.decode(replyBody);
}

async function leaveFriendFarm(friendGid) {
    const body = types.VisitLeaveRequest.encode(types.VisitLeaveRequest.create({
        host_gid: toLong(friendGid),
    })).finish();
    try {
        await sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', body);
    } catch { /* 离开失败不影响主流程 */ }
}

// 北京时间日期 YYYY-MM-DD（服务器时间 UTC+8，避免时区偏差）
function getBeijingDateKey() {
    const nowSec = getServerTimeSec();
    const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
    const bjDate = new Date(nowMs + 8 * 3600 * 1000);
    const y = bjDate.getUTCFullYear();
    const m = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(bjDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// 当日捣蛋停用状态持久化（重启/跨日避免重复踩 1001046）
function getBadDailyStateFile() {
    const accountId = String(process.env.FARM_ACCOUNT_ID || 'default');
    const token = crypto.createHash('sha256').update(accountId, 'utf8').digest('hex');
    return getDataFile(`friend-bad-state-${token}.json`);
}

function loadBadDailyStop(today) {
    const state = readJsonFile(getBadDailyStateFile(), () => ({}));
    return Number(state && state.version) === BAD_DAILY_STATE_VERSION
        && String((state && state.date) || '') === today
        && state && state.stopped === true;
}

function persistBadDailyStop(today) {
    try {
        writeJsonFileAtomic(getBadDailyStateFile(), {
            version: BAD_DAILY_STATE_VERSION,
            date: today,
            stopped: true,
        });
    } catch (e) {
        logWarn('好友', `保存当日捣乱停用状态失败: ${e.message}`);
    }
}

/**
 * 检查是否需要重置每日限制 (0点刷新)
 */
function checkDailyReset() {
    const today = getBeijingDateKey();
    if (lastResetDate !== today) {
        if (lastResetDate !== '') {
            log('系统', '跨日重置，清空操作限制缓存');
        }
        operationLimits.clear();
        canGetHelpExp = true;
        // 跨日/重启后恢复当日的捣蛋停用状态（吃到上限当天不再重复尝试）
        badOperationLimitReached = loadBadDailyStop(today);
        if (helpAutoDisabledByLimit) {
            helpAutoDisabledByLimit = false;
            log('好友', '新的一天已开始，自动恢复帮忙操作功能', {
                module: 'friend',
                event: '好友巡查循环',
                result: 'ok',
            });
        }
        lastResetDate = today;
    }
}

function autoDisableHelpByExpLimit() {
    if (!canGetHelpExp) return;
    canGetHelpExp = false;
    helpAutoDisabledByLimit = true;
    log('好友', '今日帮助经验已达上限，自动停止帮忙', {
        module: 'friend',
        event: '好友巡查循环',
        result: 'ok',
    });
}

/**
 * 更新操作限制状态
 */
function updateOperationLimits(limits) {
    if (!limits || limits.length === 0) return;
    checkDailyReset();
    for (const limit of limits) {
        const id = toNum(limit.id);
        if (id > 0) {
            const data = {
                dayTimes: toNum(limit.day_times),
                dayTimesLimit: toNum(limit.day_times_lt),
                dayExpTimes: toNum(limit.day_exp_times),
                dayExpTimesLimit: toNum(limit.day_ex_times_lt), // 协议字段名为 day_ex_times_lt
            };
            operationLimits.set(id, data);
            // 捣乱共享额度满额立即停用（无需等服务端 1001046）
            if (id === BAD_SHARED_LIMIT_ID && data.dayTimesLimit > 0 && data.dayTimes >= data.dayTimesLimit) {
                markBadOperationLimitReached('operation_limit');
            }
        }
    }
}

function isBadOperationLimitReached() {
    checkDailyReset();
    return badOperationLimitReached;
}

function markBadOperationLimitReached(method = '') {
    checkDailyReset();
    if (badOperationLimitReached) return false;
    badOperationLimitReached = true;
    persistBadDailyStop(lastResetDate || getBeijingDateKey());
    log('好友', '今日放虫/放草次数已达上限，停止两类操作', {
        module: 'friend',
        event: '放虫放草次数上限',
        ...(method ? { method } : {}),
    });
    return true;
}

// 捣乱共享额度（10003）剩余次数
function getRemainingBadOperationTimes() {
    checkDailyReset();
    if (badOperationLimitReached) return 0;
    const limit = operationLimits.get(BAD_SHARED_LIMIT_ID);
    if (!limit || limit.dayTimesLimit <= 0) return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}

function canGetExpByCandidates(opIds = []) {
    const ids = Array.isArray(opIds) ? opIds : [opIds];
    for (const id of ids) {
        if (canGetExp(toNum(id))) return true;
    }
    return false;
}

/**
 * 检查某操作是否还能获得经验
 */
function canGetExp(opId) {
    const limit = operationLimits.get(opId);
    if (!limit) return false;  // 没有限制信息，保守起见不帮助（等待限制数据）
    if (limit.dayExpTimesLimit <= 0) return true;  // 没有经验上限
    return limit.dayExpTimes < limit.dayExpTimesLimit;
}

/**
 * 检查某操作是否还有次数
 */
function canOperate(opId) {
    const limit = operationLimits.get(opId);
    if (!limit) return true;
    if (limit.dayTimesLimit <= 0) return true;
    return limit.dayTimes < limit.dayTimesLimit;
}

/**
 * 获取某操作剩余次数
 */
function getRemainingTimes(opId) {
    const limit = operationLimits.get(opId);
    if (!limit || limit.dayTimesLimit <= 0) return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}

/**
 * 获取操作限制详情 (供管理面板使用)
 */
function getOperationLimits() {
    const result = {};
    for (const id of [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008]) {
        const limit = operationLimits.get(id);
        if (limit) {
            result[id] = {
                name: OP_NAMES[id] || `#${id}`,
                ...limit,
                remaining: getRemainingTimes(id),
            };
        }
    }
    return result;
}

async function helpWater(friendGid, landIds, stopWhenExpLimit = false) {
    const beforeExp = toNum((getUserState() || {}).exp);
    const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
    const reply = types.WaterLandReply.decode(replyBody);
    updateOperationLimits(reply.operation_limits);
    if (stopWhenExpLimit) {
        await sleep(200);
        const afterExp = toNum((getUserState() || {}).exp);
        if (afterExp <= beforeExp) autoDisableHelpByExpLimit();
    }
    return reply;
}

async function helpWeed(friendGid, landIds, stopWhenExpLimit = false) {
    const beforeExp = toNum((getUserState() || {}).exp);
    const body = types.WeedOutRequest.encode(types.WeedOutRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WeedOut', body);
    const reply = types.WeedOutReply.decode(replyBody);
    updateOperationLimits(reply.operation_limits);
    if (stopWhenExpLimit) {
        await sleep(200);
        const afterExp = toNum((getUserState() || {}).exp);
        if (afterExp <= beforeExp) autoDisableHelpByExpLimit();
    }
    return reply;
}

async function helpInsecticide(friendGid, landIds, stopWhenExpLimit = false) {
    const beforeExp = toNum((getUserState() || {}).exp);
    const body = types.InsecticideRequest.encode(types.InsecticideRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Insecticide', body);
    const reply = types.InsecticideReply.decode(replyBody);
    updateOperationLimits(reply.operation_limits);
    if (stopWhenExpLimit) {
        await sleep(200);
        const afterExp = toNum((getUserState() || {}).exp);
        if (afterExp <= beforeExp) autoDisableHelpByExpLimit();
    }
    return reply;
}

async function stealHarvest(friendGid, landIds) {
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    const reply = types.HarvestReply.decode(replyBody);
    updateOperationLimits(reply.operation_limits);
    return reply;
}

async function putPlantItems(friendGid, landIds, RequestType, ReplyType, method) {
    let ok = 0;
    const ids = Array.isArray(landIds) ? landIds : [];
    for (const landId of ids) {
        // 预检查共享额度/停用标记（与 putPlantItemsDetailed 一致）
        if (isBadOperationLimitReached() || getRemainingBadOperationTimes() <= 0) {
            markBadOperationLimitReached(method);
            break;
        }
        try {
            // field_4=2 为抓包确认的操作类型（线上请求带 field 3=0/field 4=2）
            const body = RequestType.encode(RequestType.create({
                land_ids: [toLong(landId)],
                host_gid: toLong(friendGid),
                field_4: 2,
            })).finish();
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body);
            const reply = ReplyType.decode(replyBody);
            updateOperationLimits(reply.operation_limits);
            ok++;
        } catch (e) {
            // 检查是否是次数已达上限的错误
            if (e.message && e.message.includes('1001046')) {
                markBadOperationLimitReached(method);
                log('好友', `放虫/放草次数已达上限，停止执行`, { module: 'friend', event: '放虫放草次数上限' });
                break; // 次数用完，立即停止
            }
            // 记录其他错误
            log('好友', `放虫/放草失败: landId=${landId}, 错误: ${e.message}`, { module: 'friend', event: '放虫放草失败', landId, error: e.message });
            await randomDelay(2000, 3500);
        }
        if (ok > 0) {
            await randomDelay(2000, 3500);
        }
    }
    return ok;
}

async function putPlantItemsDetailed(friendGid, landIds, RequestType, ReplyType, method) {
    let ok = 0;
    const failed = [];
    const ids = Array.isArray(landIds) ? landIds : [];
    for (let index = 0; index < ids.length; index++) {
        const landId = ids[index];
        // 每块请求前检查共享额度/停用标记，避免吃满 1001046 后继续空试
        if (isBadOperationLimitReached() || getRemainingBadOperationTimes() <= 0) {
            markBadOperationLimitReached(method);
            failed.push(...ids.slice(index).map(id => ({ landId: id, reason: '今日放虫/放草次数已达上限' })));
            break;
        }
        try {
            const body = RequestType.encode(RequestType.create({
                land_ids: [toLong(landId)],
                host_gid: toLong(friendGid),
                field_4: 2,
            })).finish();
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body);
            const reply = ReplyType.decode(replyBody);
            updateOperationLimits(reply.operation_limits);
            ok++;
        } catch (e) {
            if (e.message && e.message.includes('1001046')) {
                markBadOperationLimitReached(method);
                failed.push(...ids.slice(index).map(id => ({ landId: id, reason: '今日放虫/放草次数已达上限' })));
                break;
            }
            failed.push({ landId, reason: e && e.message ? e.message : '未知错误' });
        }
        // 逐块节奏（含失败），防服务端软限流
        await randomDelay(2000, 3500);
    }
    return { ok, failed };
}

async function putInsects(friendGid, landIds) {
    return putPlantItems(friendGid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
}

async function putWeeds(friendGid, landIds) {
    return putPlantItems(friendGid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
}

async function putInsectsDetailed(friendGid, landIds) {
    return putPlantItemsDetailed(friendGid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
}

async function putWeedsDetailed(friendGid, landIds) {
    return putPlantItemsDetailed(friendGid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
}

async function checkCanOperateRemote(friendGid, operationId) {
    if (!types.CheckCanOperateRequest || !types.CheckCanOperateReply) {
        return { canOperate: true, canStealNum: 0 };
    }
    try {
        const body = types.CheckCanOperateRequest.encode(types.CheckCanOperateRequest.create({
            host_gid: toLong(friendGid),
            operation_id: toLong(operationId),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'CheckCanOperate', body);
        const reply = types.CheckCanOperateReply.decode(replyBody);
        return {
            canOperate: !!reply.can_operate,
            canStealNum: toNum(reply.can_steal_num),
        };
    } catch {
        // 预检查失败时降级为不拦截，避免因协议抖动导致完全不操作
        return { canOperate: true, canStealNum: 0 };
    }
}

// ============ 好友土地分析 ============

function analyzeFriendLands(lands, myGid, friendName = '', options = {}) {
    const { plantBlacklist = null } = options;
    const result = {
        stealable: [],   // 可偷
        stealableInfo: [],  // 可偷植物信息 { landId, plantId, name }
        needWater: [],   // 需要浇水
        needWeed: [],    // 需要除草
        needBug: [],     // 需要除虫
        canPutWeed: [],  // 可以放草
        canPutBug: [],   // 可以放虫
    };
    const landsMap = buildLandMap(lands);

    for (const land of lands) {
        const id = toNum(land.id);
        if (isOccupiedSlaveLand(land, landsMap)) {
            continue;
        }
        const plant = land.plant;

        if (!plant || !plant.phases || plant.phases.length === 0) {
            continue;
        }

        const currentPhase = getCurrentPhase(plant.phases, false, `[${friendName}]土地#${id}`);
        if (!currentPhase) {
            continue;
        }
        const phaseVal = currentPhase.phase;

        if (phaseVal === PlantPhase.MATURE) {
            if (plant.stealable) {
                const plantId = toNum(plant.id);
                const plantName = getPlantName(plantId) || plant.name || '未知';

                // 获取种子ID用于黑名单检查（前端黑名单使用seedId）
                const plantCfg = getPlantById(plantId);
                const seedId = toNum(plantCfg && plantCfg.seed_id) || deriveSeedIdFromPlantId(plantId);

                // 蔬菜黑名单过滤 - 使用seedId检查
                if (plantBlacklist && seedId > 0 && plantBlacklist.includes(seedId)) {
                    // log('好友', `${friendName} 土地#${id}: ${plantName}(${plantId},种子${seedId}) 被蔬菜黑名单过滤跳过`,
                    //     {
                    //     module: 'friend', event: '蔬菜黑名单跳过', friendName, landId: id, plantId, seedId, plantName
                    // });
                    continue;
                }
                result.stealable.push(id);
                result.stealableInfo.push({ landId: id, plantId, name: plantName });
            }
            continue;
        }

        if (phaseVal === PlantPhase.DEAD) continue;

        // 帮助操作
        if (toNum(plant.dry_num) > 0) result.needWater.push(id);
        if (plant.weed_owners && plant.weed_owners.length > 0) result.needWeed.push(id);
        if (plant.insect_owners && plant.insect_owners.length > 0) result.needBug.push(id);

        // 捣乱操作: 检查是否可以放草/放虫
        // 条件: 植物未成熟 + 没有草/虫且我没放过 + 每块地最多2个草/虫
        if (phaseVal !== PlantPhase.MATURE) {
            const weedOwners = plant.weed_owners || [];
            const insectOwners = plant.insect_owners || [];
            const iAlreadyPutWeed = weedOwners.some(gid => toNum(gid) === myGid);
            const iAlreadyPutBug = insectOwners.some(gid => toNum(gid) === myGid);

            // 每块地最多2个草/虫，且我没放过
            if (weedOwners.length < 2 && !iAlreadyPutWeed) {
                result.canPutWeed.push(id);
            }
            if (insectOwners.length < 2 && !iAlreadyPutBug) {
                result.canPutBug.push(id);
            }
        }
    }
    return result;
}

/**
 * 获取好友列表 (供面板)
 */
async function getFriendsList(forceSync = false) {
    try {
        // 检查缓存
        const now = Date.now();
        if (!forceSync && friendsListCache && (now - friendsListCacheTime) < getFriendsListCacheTtlMs()) {

            return friendsListCache;
        }

        log('好友', '开始获取好友列表', {
            module: 'friend',
            event: '获取好友列表',
        });
        const reply = await getAllFriends(forceSync);
        const friends = reply.game_friends || [];
        const state = getUserState();
        const result = friends
            .filter(f => toNum(f.gid) !== state.gid && f.name !== '小小农夫' && f.remark !== '小小农夫')
            .map(f => ({
                gid: toNum(f.gid),
                name: f.remark || f.name || `GID:${toNum(f.gid)}`,
                avatarUrl: String(f.avatar_url || '').trim(),
                level: toNum(f.level),
                gold: toNum(f.gold),
                plant: f.plant ? {
                    stealNum: toNum(f.plant.steal_plant_num),
                    dryNum: toNum(f.plant.dry_num),
                    weedNum: toNum(f.plant.weed_num),
                    insectNum: toNum(f.plant.insect_num),
                } : null,
            }))
            .sort((a, b) => {
                // 固定顺序：先按名称，再按 GID，避免刷新时顺序抖动
                const an = String(a.name || '');
                const bn = String(b.name || '');
                const byName = an.localeCompare(bn, 'zh-CN');
                if (byName !== 0) return byName;
                return Number(a.gid || 0) - Number(b.gid || 0);
            });
        
        // 更新缓存
        friendsListCache = result;
        friendsListCacheTime = now;
        
        log('好友', `获取好友列表成功，共 ${result.length} 位好友`, {
            module: 'friend',
            event: '获取好友列表',
            result: 'ok',
            count: result.length,
        });
        return result;
    } catch (e) {
        log('好友', `获取好友列表失败: ${e.message}`, {
            module: 'friend',
            event: '获取好友列表',
            result: 'error',
            error: e.message,
        });
        return [];
    }
}

/**
 * 获取指定好友的农田详情 (进入-获取-离开)
 */
async function getFriendLandsDetail(friendGid) {
    try {
        const enterReply = await enterFriendFarm(friendGid);
        const lands = enterReply.lands || [];
        const state = getUserState();
        const plantBlacklist = getPlantBlacklist(state.accountId);
        const analyzed = analyzeFriendLands(lands, state.gid, '', { plantBlacklist });
        await leaveFriendFarm(friendGid);

        const landsList = [];
        const nowSec = getServerTimeSec();
        const landsMap = buildLandMap(lands);
        for (const land of lands) {
            const id = toNum(land.id);
            const level = toNum(land.level);
            const unlocked = !!land.unlocked;
            const {
                sourceLand,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
            } = getDisplayLandContext(land, landsMap);
            if (!unlocked) {
                landsList.push({
                    id,
                    unlocked: false,
                    status: 'locked',
                    plantName: '',
                    phaseName: '未解锁',
                    level,
                    needWater: false,
                    needWeed: false,
                    needBug: false,
                    occupiedByMaster: false,
                    masterLandId: 0,
                    occupiedLandIds: [],
                    plantSize: 1,
                });
                continue;
            }
            const plant = sourceLand && sourceLand.plant;
            if (!plant || !plant.phases || plant.phases.length === 0) {
                landsList.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '空地',
                    level,
                    occupiedByMaster,
                    masterLandId,
                    occupiedLandIds,
                    plantSize: 1,
                });
                continue;
            }
            const currentPhase = getCurrentPhase(plant.phases, false, '');
            if (!currentPhase) {
                landsList.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '',
                    level,
                    occupiedByMaster,
                    masterLandId,
                    occupiedLandIds,
                    plantSize: 1,
                });
                continue;
            }
            const phaseVal = currentPhase.phase;
            const plantId = toNum(plant.id);
            const plantName = getPlantName(plantId) || plant.name || '未知';
            const plantCfg = getPlantById(plantId);
            const seedId = toNum(plantCfg && plantCfg.seed_id) || deriveSeedIdFromPlantId(plantId);
            const seedImage = seedId > 0 ? getSeedImageBySeedId(seedId) : '';
            const plantSize = Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
            const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
            const currentSeasonRaw = toNum(plant.season);
            const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;
            const phaseName = PHASE_NAMES[phaseVal] || '';
            const maturePhase = Array.isArray(plant.phases)
                ? plant.phases.find((p) => p && toNum(p.phase) === PlantPhase.MATURE)
                : null;
            const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
            const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;
            const totalGrowTime = getPlantGrowTime(plantId);
            let landStatus = 'growing';
            if (phaseVal === PlantPhase.MATURE) landStatus = plant.stealable ? 'stealable' : 'harvested';
            else if (phaseVal === PlantPhase.DEAD) landStatus = 'dead';

            landsList.push({
                id,
                unlocked: true,
                status: landStatus,
                plantName,
                seedId,
                seedImage,
                phaseName,
                currentSeason,
                totalSeason,
                level,
                matureInSec,
                totalGrowTime,
                needWater: toNum(plant.dry_num) > 0,
                needWeed: (plant.weed_owners && plant.weed_owners.length > 0),
                needBug: (plant.insect_owners && plant.insect_owners.length > 0),
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
                plantSize,
            });
        }

        return {
            lands: landsList,
            summary: analyzed,
        };
    } catch {
        return { lands: [], summary: {} };
    }
}

async function runBatchWithFallback(ids, batchFn, singleFn) {
    const target = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (target.length === 0) return 0;
    try {
        await batchFn(target);
        return target.length;
    } catch {
        let ok = 0;
        for (const landId of target) {
            try {
                await singleFn([landId]);
                ok++;
            } catch { /* ignore */ }
            await sleep(100);
        }
        return ok;
    }
}

/**
 * 面板手动好友操作（单个好友）
 * opType: 'steal' | 'water' | 'weed' | 'bug' | 'bad'
 */
async function doFriendOperation(friendGid, opType) {
    const gid = toNum(friendGid);
    if (!gid) return { ok: false, message: '无效好友ID', opType };

    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    } catch (e) {
        const handled = handleFriendEnterError(gid, `GID:${gid}`, e);
        if (handled.handled && handled.kind === 'blacklist') {
            return { ok: true, opType, count: 0, message: '好友已自动加入黑名单' };
        }
        if (handled.handled && handled.kind === 'invalid_removed') {
            return { ok: true, opType, count: 0, message: '好友 GID 已失效，已自动移出已知列表' };
        }
        return { ok: false, message: `进入好友农场失败: ${e.message}`, opType };
    }

    try {
        const lands = enterReply.lands || [];
        const state = getUserState();
        const plantBlacklist = getPlantBlacklist(state.accountId);
        const status = analyzeFriendLands(lands, state.gid, '', { plantBlacklist });
        let count = 0;

        if (opType === 'steal') {
            if (!status.stealable.length) return { ok: true, opType, count: 0, message: '没有可偷取土地' };
            const precheck = await checkCanOperateRemote(gid, 10008);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: 'Ta已经被偷的精光了QAQ' };
            const maxNum = precheck.canStealNum > 0 ? precheck.canStealNum : status.stealable.length;
            const target = status.stealable.slice(0, maxNum);
            count = await runBatchWithFallback(target, (ids) => stealHarvest(gid, ids), (ids) => stealHarvest(gid, ids));
            if (count > 0) {
                recordOperation('steal', count);
                // 手动偷取成功后立即尝试出售一次果实
                try {
                    await sellAllFruits();
                } catch (e) {
                    logWarn('仓库', `手动偷取后自动出售失败: ${e.message}`, {
                        module: 'warehouse',
                        event: '偷菜后出售',
                        result: 'error',
                        mode: 'manual',
                    });
                }
            }
            return { ok: true, opType, count, message: `偷取完成 ${count} 块` };
        }

        if (opType === 'water') {
            if (!status.needWater.length) return { ok: true, opType, count: 0, message: '没有可浇水土地' };
            const precheck = await checkCanOperateRemote(gid, 10007);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '浇水失败，来晚一步，可惜' };
            count = await runBatchWithFallback(status.needWater, (ids) => helpWater(gid, ids), (ids) => helpWater(gid, ids));
            if (count > 0) recordOperation('helpWater', count);
            return { ok: true, opType, count, message: `浇水完成 ${count} 块` };
        }

        if (opType === 'weed') {
            if (!status.needWeed.length) return { ok: true, opType, count: 0, message: '没有可除草土地' };
            const precheck = await checkCanOperateRemote(gid, 10005);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '除草失败，来晚一步，可惜' };
            count = await runBatchWithFallback(status.needWeed, (ids) => helpWeed(gid, ids), (ids) => helpWeed(gid, ids));
            if (count > 0) recordOperation('helpWeed', count);
            return { ok: true, opType, count, message: `除草完成 ${count} 块` };
        }

        if (opType === 'bug') {
            if (!status.needBug.length) return { ok: true, opType, count: 0, message: '没有可除虫土地' };
            const precheck = await checkCanOperateRemote(gid, 10006);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '除虫失败，来晚一步，可惜' };
            count = await runBatchWithFallback(status.needBug, (ids) => helpInsecticide(gid, ids), (ids) => helpInsecticide(gid, ids));
            if (count > 0) recordOperation('helpBug', count);
            return { ok: true, opType, count, message: `除虫完成 ${count} 块` };
        }

        if (opType === 'bad') {
            let bugCount = 0;
            let weedCount = 0;
            if (isBadOperationLimitReached()) {
                return { ok: true, opType, count: 0, bugCount: 0, weedCount: 0, message: '今日放虫/放草次数已达上限' };
            }
            if (!status.canPutBug.length && !status.canPutWeed.length) {
                return { ok: true, opType, count: 0, bugCount: 0, weedCount: 0, message: '没有可捣乱土地' };
            }

            // 手动捣乱不依赖预检查，逐块执行；放草优先（共享额度有限时先放草，与参考仓库一致）
            let failDetails = [];
            if (status.canPutWeed.length && !isBadOperationLimitReached()) {
                const weedRet = await putWeedsDetailed(gid, status.canPutWeed);
                weedCount = weedRet.ok;
                failDetails = failDetails.concat((weedRet.failed || []).map(f => `放草#${f.landId}:${f.reason}`));
                if (weedCount > 0) recordOperation('weed', weedCount);
            }
            if (status.canPutBug.length && !isBadOperationLimitReached()) {
                const bugRet = await putInsectsDetailed(gid, status.canPutBug);
                bugCount = bugRet.ok;
                failDetails = failDetails.concat((bugRet.failed || []).map(f => `放虫#${f.landId}:${f.reason}`));
                if (bugCount > 0) recordOperation('bug', bugCount);
            }
            count = bugCount + weedCount;
            if (count <= 0) {
                const reasonPreview = failDetails.slice(0, 2).join(' | ');
                return {
                    ok: true,
                    opType,
                    count: 0,
                    bugCount,
                    weedCount,
                    message: reasonPreview ? `捣乱失败: ${reasonPreview}` : '捣乱失败或今日次数已用完'
                };
            }
            return { ok: true, opType, count, bugCount, weedCount, message: `捣乱完成 虫${bugCount}/草${weedCount}` };
        }

        return { ok: false, opType, count: 0, message: '未知操作类型' };
    } catch (e) {
        return { ok: false, opType, count: 0, message: e.message || '操作失败' };
    } finally {
        try { await leaveFriendFarm(gid); } catch { /* ignore */ }
    }
}

// ============ 拜访好友 ============

async function visitFriend(friend, totalActions, myGid, accountId) {
    const { gid, name } = friend;

    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    } catch (e) {
        const handled = handleFriendEnterError(gid, name, e);
        if (handled.handled && handled.kind === 'blacklist') {
            return { acted: false, entered: false };
        }
        if (handled.handled && handled.kind === 'invalid_removed') {
            return { acted: false, entered: false };
        }
        logWarn('好友', `进入 ${name} 农场失败: ${e.message}`, {
            module: 'friend', event: '进入农场', result: 'error', friendName: name, friendGid: gid
        });
        return { acted: false, entered: false };
    }

    const lands = enterReply.lands || [];
    if (lands.length === 0) {
        await leaveFriendFarm(gid);
        return { acted: false, entered: true };
    }

    const plantBlacklist = getPlantBlacklist(accountId);
    const status = analyzeFriendLands(lands, myGid, name, { plantBlacklist });

    // 执行操作
    const actions = [];

    // 1. 帮助操作 (除草/除虫/浇水)
    const helpEnabled = !!isAutomationOn('friend_help');
    const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit');
    if (!stopWhenExpLimit) canGetHelpExp = true;
    if (!helpEnabled) {
        // 自动帮忙关闭，直接跳过帮助操作
    } else if (stopWhenExpLimit && !canGetHelpExp) {
        // 今日已达到经验上限后停止帮忙
    } else {
        const helpOps = [
            { id: 10005, expIds: [10005, 10003], list: status.needWeed, fn: helpWeed, key: 'weed', name: '草', record: 'helpWeed' },
            { id: 10006, expIds: [10006, 10002], list: status.needBug, fn: helpInsecticide, key: 'bug', name: '虫', record: 'helpBug' },
            { id: 10007, expIds: [10007, 10001], list: status.needWater, fn: helpWater, key: 'water', name: '水', record: 'helpWater' }
        ];

        for (const op of helpOps) {
            const allowByExp = (!stopWhenExpLimit) || (canGetExpByCandidates(op.expIds) && canGetHelpExp);
            if (op.list.length > 0 && allowByExp) {
                const precheck = await checkCanOperateRemote(gid, op.id);
                if (precheck.canOperate) {
                    const count = await runBatchWithFallback(
                        op.list,
                        (ids) => op.fn(gid, ids, stopWhenExpLimit),
                        (ids) => op.fn(gid, ids, stopWhenExpLimit)
                    );
                    if (count > 0) {
                        actions.push(`${op.name}${count}`);
                        totalActions[op.key] += count;
                        recordOperation(op.record, count);
                        await randomDelay(500, 800);
                    }
                }
            }
        }
    }

    // 2. 偷菜操作
    if (isAutomationOn('friend_steal') && status.stealable.length > 0) {
        const precheck = await checkCanOperateRemote(gid, 10008);
        if (precheck.canOperate) {
            const canStealNum = precheck.canStealNum > 0 ? precheck.canStealNum : status.stealable.length;
            const targetLands = status.stealable.slice(0, canStealNum);
            
            let ok = 0;
            const stolenPlants = [];
            
            // 尝试批量偷取
            try {
                await stealHarvest(gid, targetLands);
                ok = targetLands.length;
                targetLands.forEach(id => {
                    const info = status.stealableInfo.find(x => x.landId === id);
                    if (info) stolenPlants.push(info.name);
                });
            } catch {
                // 批量失败，降级为单个
                for (const landId of targetLands) {
                    try {
                        await stealHarvest(gid, [landId]);
                        ok++;
                        const info = status.stealableInfo.find(x => x.landId === landId);
                        if (info) stolenPlants.push(info.name);
                    } catch { /* ignore */ }
                    await randomDelay(500, 800);
                }
            }

            if (ok > 0) {
                const plantNames = [...new Set(stolenPlants)].join('/');
                actions.push(`偷${ok}${plantNames ? `(${  plantNames  })` : ''}`);
                totalActions.steal += ok;
                recordOperation('steal', ok);
                await randomDelay(500, 800);
            }
        }
    }

    // 3. 捣乱操作 (放虫/放草) —— 共享额度 10003，放草优先（额度有限时先放草，与参考仓库一致）
    const autoBad = isAutomationOn('friend_bad');
    if (autoBad && !isBadOperationLimitReached()) {
        const remainingBad = getRemainingBadOperationTimes();
        if (remainingBad > 0) {
            if (status.canPutWeed.length > 0) {
                const weedCheck = await checkCanOperateRemote(gid, BAD_SHARED_LIMIT_ID);
                if (weedCheck.canOperate) {
                    const toProcess = status.canPutWeed.slice(0, remainingBad);
                    const ok = await putWeeds(gid, toProcess);
                    if (ok > 0) { actions.push(`放草${ok}`); totalActions.putWeed += ok; }
                    await randomDelay(2000, 3500);
                }
            }

            if (!isBadOperationLimitReached() && status.canPutBug.length > 0) {
                const bugCheck = await checkCanOperateRemote(gid, 10004);
                if (bugCheck.canOperate) {
                    const toProcess = status.canPutBug.slice(0, getRemainingBadOperationTimes());
                    const ok = await putInsects(gid, toProcess);
                    if (ok > 0) { actions.push(`放虫${ok}`); totalActions.putBug += ok; }
                    await randomDelay(2000, 3500);
                }
            }
        }
    }

    if (actions.length > 0) {
        log('好友', `${name}: ${actions.join('/')}`, {
            module: 'friend', event: '照顾好友', result: 'ok', friendName: name, friendGid: gid, actions
        });
    }

    await leaveFriendFarm(gid);
    return { acted: actions.length > 0, entered: true };
}

// ============ 仅偷菜 ============

async function visitFriendForSteal(friend, totalActions, myGid, accountId) {
    const { gid, name } = friend;

    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    } catch (e) {
        const handled = handleFriendEnterError(gid, name, e);
        if (handled.handled) {
            return { acted: false, entered: false };
        }
        logWarn('好友', `进入 ${name} 农场失败: ${e.message}`, {
            module: 'friend', event: '进入农场', result: 'error', friendName: name, friendGid: gid
        });
        return { acted: false, entered: false };
    }

    const lands = enterReply.lands || [];
    if (lands.length === 0) {
        await leaveFriendFarm(gid);
        return { acted: false, entered: true };
    }

    const plantBlacklist = getPlantBlacklist(accountId);
    const status = analyzeFriendLands(lands, myGid, name, { plantBlacklist });

    const actions = [];

    // 检查是否所有可偷蔬菜都被黑名单过滤了（只统计成熟的、可偷的植物）
    const hasStealableBeforeFilter = lands.some(land => {
        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) return false;
        const currentPhase = getCurrentPhase(land.plant.phases, false);
        if (!currentPhase || currentPhase.phase !== PlantPhase.MATURE) return false;
        if (!plant.stealable) return false;
        const stealInfo = plant.steal_player;
        if (!stealInfo || stealInfo.length === 0) return true; // 无人偷过，可偷
        const mySteal = stealInfo.find(s => toNum(s.gid) === myGid);
        const stealCount = mySteal ? toNum(mySteal.num) : 0;
        const maxSteal = toNum(plant.steal_num, 2);
        return stealCount < maxSteal;
    });

    if (hasStealableBeforeFilter && status.stealable.length === 0) {
        // log('好友', `${name}: 跳过，所有可偷蔬菜都被黑名单过滤`, {
        //     module: 'friend', event: '偷菜全部过滤', friendName: name, friendGid: gid
        // });
        await leaveFriendFarm(gid);
        return;
    }

    // 只执行偷菜
    if (status.stealable.length > 0) {
        const precheck = await checkCanOperateRemote(gid, 10008);
        if (precheck.canOperate) {
            const canStealNum = precheck.canStealNum > 0 ? precheck.canStealNum : status.stealable.length;
            const targetLands = status.stealable.slice(0, canStealNum);

            let ok = 0;
            const stolenPlants = [];

            // 尝试批量偷取
            try {
                await stealHarvest(gid, targetLands);
                ok = targetLands.length;
                targetLands.forEach(id => {
                    const info = status.stealableInfo.find(x => x.landId === id);
                    if (info) stolenPlants.push(info.name);
                });
            } catch {
                // 批量失败，降级为单个
                for (const landId of targetLands) {
                    try {
                        await stealHarvest(gid, [landId]);
                        ok++;
                        const info = status.stealableInfo.find(x => x.landId === landId);
                        if (info) stolenPlants.push(info.name);
                    } catch { /* ignore */ }
                    await randomDelay(500, 800);
                }
            }

            if (ok > 0) {
                const plantNames = [...new Set(stolenPlants)].join('/');
                actions.push(`偷${ok}${plantNames ? `(${plantNames})` : ''}`);
                totalActions.steal += ok;
                recordOperation('steal', ok);
                await randomDelay(500, 800);
            }
        }
    }

    if (actions.length > 0) {
        log('好友', `${name}: ${actions.join('/')}`, {
            module: 'friend', event: '偷好友菜', result: 'ok', friendName: name, friendGid: gid, actions
        });
    }

    await leaveFriendFarm(gid);
    return { acted: actions.length > 0, entered: true };
}

// ============ 仅帮助 ============

async function visitFriendForHelp(friend, totalActions, myGid, accountId, ignoreExpLimit = false) {
    const { gid, name } = friend;

    const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
    if (!stopWhenExpLimit) canGetHelpExp = true;
    if (stopWhenExpLimit && !canGetHelpExp) {
        return { acted: false, entered: false };
    }

    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    } catch (e) {
        const handled = handleFriendEnterError(gid, name, e);
        if (handled.handled) {
            return { acted: false, entered: false };
        }
        logWarn('好友', `进入 ${name} 农场失败: ${e.message}`, {
            module: 'friend', event: '进入农场', result: 'error', friendName: name, friendGid: gid
        });
        return { acted: false, entered: false };
    }

    const lands = enterReply.lands || [];
    if (lands.length === 0) {
        await leaveFriendFarm(gid);
        return;
    }

    const status = analyzeFriendLands(lands, myGid, name, {});

    const actions = [];

    const helpOps = [
        { id: 10005, expIds: [10005, 10003], list: status.needWeed, fn: helpWeed, key: 'weed', name: '草', record: 'helpWeed' },
        { id: 10006, expIds: [10006, 10002], list: status.needBug, fn: helpInsecticide, key: 'bug', name: '虫', record: 'helpBug' },
        { id: 10007, expIds: [10007, 10001], list: status.needWater, fn: helpWater, key: 'water', name: '水', record: 'helpWater' }
    ];

    for (const op of helpOps) {
        const allowByExp = (!stopWhenExpLimit) || (canGetExpByCandidates(op.expIds) && canGetHelpExp);
        if (op.list.length > 0 && allowByExp) {
            const precheck = await checkCanOperateRemote(gid, op.id);
            if (precheck.canOperate) {
                const count = await runBatchWithFallback(
                    op.list,
                    (ids) => op.fn(gid, ids, stopWhenExpLimit),
                    (ids) => op.fn(gid, ids, stopWhenExpLimit)
                );
                if (count > 0) {
                    actions.push(`${op.name}${count}`);
                    totalActions[op.key] += count;
                    recordOperation(op.record, count);
                    await randomDelay(500, 800);
                }
            }
        }
    }

    if (actions.length > 0) {
        log('好友', `${name}: ${actions.join('/')}`, {
            module: 'friend', event: '帮助好友', result: 'ok', friendName: name, friendGid: gid, actions
        });
    }

    await leaveFriendFarm(gid);
    return { acted: actions.length > 0, entered: true };
}

// ============ 好友巡查主循环 ============

async function checkFriends(options = {}) {
    const state = getUserState();
    if (!isAutomationOn('friend')) return false;
    
    const accountId = process.env.FARM_ACCOUNT_ID || '';

    const helpEnabled = !!isAutomationOn('friend_help');
    const stealEnabled = !!isAutomationOn('friend_steal');
    const badEnabled = !!isAutomationOn('friend_bad');
    
    const onlyHelp = options.onlyHelp || false;
    const onlySteal = options.onlySteal || false;
    const onlyBad = options.onlyBad || false;
    const ignoreExpLimit = options.ignoreExpLimit || false;
    
    const effectiveHelpEnabled = onlyHelp ? true : (onlySteal || onlyBad ? false : helpEnabled);
    const effectiveStealEnabled = onlySteal ? true : (onlyHelp || onlyBad ? false : stealEnabled);
    const effectiveBadEnabled = onlyBad ? true : (onlyHelp || onlySteal ? false : badEnabled);
    
    const hasAnyFriendOp = effectiveHelpEnabled || effectiveStealEnabled || effectiveBadEnabled;
    if (isCheckingFriends || !state.gid || !hasAnyFriendOp) return false;
    if (inFriendQuietHours()) return false;

    isCheckingFriends = true;
    checkDailyReset();

    try {
        const friendsReply = await getAllFriends();
        const friends = extractReplyFriends(friendsReply);
        if (friends.length === 0) {
            log('好友', '没有好友', { module: 'friend', event: '好友扫描', result: 'empty' });
            return false;
        }

        const blacklist = new Set(getFriendBlacklist(accountId));

        const stealFriends = [];
        const helpFriends = [];
        const visitedGids = new Set();

        for (const f of friends) {
            const gid = toNum(f.gid);
            if (gid === state.gid) continue;
            if (visitedGids.has(gid)) continue;
            if (blacklist.has(gid)) continue;

            const name = f.remark || f.name || `GID:${gid}`;
            const p = f.plant;
            const stealNum = p ? toNum(p.steal_plant_num) : 0;
            const dryNum = p ? toNum(p.dry_num) : 0;
            const weedNum = p ? toNum(p.weed_num) : 0;
            const insectNum = p ? toNum(p.insect_num) : 0;

            if (stealNum > 0 && effectiveStealEnabled) {
                stealFriends.push({ gid, name, stealNum });
            }

            if ((dryNum > 0 || weedNum > 0 || insectNum > 0) && effectiveHelpEnabled) {
                helpFriends.push({ gid, name, dryNum, weedNum, insectNum });
            }

            visitedGids.add(gid);
        }

        // 排序：偷菜多的优先
        stealFriends.sort((a, b) => b.stealNum - a.stealNum);
        // 排序：帮助需求多的优先
        helpFriends.sort((a, b) => {
            const helpA = a.dryNum + a.weedNum + a.insectNum;
            const helpB = b.dryNum + b.weedNum + b.insectNum;
            return helpB - helpA;
        });

        const totalActions = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };

        // 第二阶段：批量偷菜
        if (stealFriends.length > 0 && effectiveStealEnabled) {
            // log('好友', `开始批量偷菜，共 ${stealFriends.length} 个好友有可偷`, {
            //     module: 'friend', event: '开始批量偷菜', count: stealFriends.length
            // });

            for (const friend of stealFriends) {
                if (!canOperate(10008)) break; // 偷菜次数用完

                try {
                    await visitFriendForSteal(friend, totalActions, state.gid, state.accountId);
                } catch {
                    // 单个好友失败不影响整体
                }
                await randomDelay(500, 800);
            }
        }

        // 偷菜后自动出售
        if (totalActions.steal > 0) {
            try {
                await sellAllFruits();
            } catch {
                // ignore
            }
        }

        // 第三阶段：批量帮助
        if (helpFriends.length > 0 && effectiveHelpEnabled) {
            log('好友', `开始批量帮助，共 ${helpFriends.length} 个好友需要帮助`, {
                module: 'friend', event: '开始批量帮助', count: helpFriends.length
            });

            for (let i = 0; i < helpFriends.length; i++) {
                const friend = helpFriends[i];
                log('好友', `批量帮助第 ${i + 1}/${helpFriends.length} 个好友: ${friend.name}`, { module: 'friend', event: '批量帮助开始', index: i + 1, total: helpFriends.length, friendName: friend.name });

                // 检查是否还能获得帮助经验
                // const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit');
                const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
                if (stopWhenExpLimit && !canGetHelpExp) {
                    log('好友', `批量帮助中断：经验已达上限`, { module: 'friend', event: '批量帮助中断', reason: 'exp_limit' });
                    break;
                }

                try {
                    // await visitFriendForHelp(friend, totalActions, state.gid, state.accountId);
                    await visitFriendForHelp(friend, totalActions, state.gid, state.accountId, ignoreExpLimit);
                    log('好友', `批量帮助第 ${i + 1} 个好友完成: ${friend.name}`, { module: 'friend', event: '批量帮助完成', index: i + 1, friendName: friend.name });
                } catch (e) {
                    log('好友', `批量帮助第 ${i + 1} 个好友失败: ${friend.name}, 错误: ${e.message}`, { module: 'friend', event: '批量帮助失败', index: i + 1, friendName: friend.name, error: e.message });
                }
                await randomDelay(500, 800);
            }
            log('好友', '批量帮助循环结束', { module: 'friend', event: '批量帮助结束' });
        }

        // 第四阶段：批量捣乱（放虫放草）
        if (effectiveBadEnabled) {
            log('好友', '开始自动放虫放草', { module: 'friend', event: '开始自动放虫放草' });
            
            const badFriends = [];
            const badVisitedGids = new Set();
            
            for (const f of friends) {
                const gid = toNum(f.gid);
                if (gid === state.gid) continue;
                if (badVisitedGids.has(gid)) continue;
                if (blacklist.has(gid)) continue;

                const name = f.remark || f.name || `GID:${gid}`;
                const p = f.plant;
                const stealNum = p ? toNum(p.steal_plant_num) : 0;
                const dryNum = p ? toNum(p.dry_num) : 0;
                const weedNum = p ? toNum(p.weed_num) : 0;
                const insectNum = p ? toNum(p.insect_num) : 0;

                // 只有没有可偷、可帮助的好友才考虑捣乱
                if (stealNum === 0 && dryNum === 0 && weedNum === 0 && insectNum === 0) {
                    const level = toNum(f.level);
                    badFriends.push({ gid, name, level });
                }

                badVisitedGids.add(gid);
            }

            // 按等级降序排序，优先处理等级高的好友
            badFriends.sort((a, b) => b.level - a.level);

            // 只取等级最高的前20个
            const topBadFriends = badFriends.slice(0, 20);
            
            if (topBadFriends.length > 0) {
                log('好友', `找到 ${badFriends.length} 个可捣乱的好友，处理等级最高的前${topBadFriends.length}个`, { module: 'friend', event: '放虫放草好友列表', totalCount: badFriends.length, topCount: topBadFriends.length });

                for (let i = 0; i < topBadFriends.length; i++) {
                    const friend = topBadFriends[i];

                    // 检查是否还有捣乱次数（共享额度 10003）
                    if (isBadOperationLimitReached() || getRemainingBadOperationTimes() <= 0) {
                        log('好友', `放虫放草次数已用完，停止执行`, { module: 'friend', event: '放虫放草次数用完' });
                        break;
                    }

                    try {
                        await visitFriend(friend, totalActions, state.gid, state.accountId);
                    } catch {
                        // 单个好友失败不影响整体
                    }
                    await randomDelay(2000, 3500);
                }
            }
        }

        // 生成总结日志
        const summary = [];
        if (totalActions.steal > 0) summary.push(`偷${totalActions.steal}`);
        if (totalActions.weed > 0) summary.push(`除草${totalActions.weed}`);
        if (totalActions.bug > 0) summary.push(`除虫${totalActions.bug}`);
        if (totalActions.water > 0) summary.push(`浇水${totalActions.water}`);
        if (totalActions.putBug > 0) summary.push(`放虫${totalActions.putBug}`);
        if (totalActions.putWeed > 0) summary.push(`放草${totalActions.putWeed}`);

        const totalVisited = stealFriends.length + helpFriends.length;
        if (summary.length > 0) {
            log('好友', `巡查完成 → ${summary.join('/')}`, {
                module: 'friend', event: '好友巡查循环', result: 'ok', visited: totalVisited, summary
            });
        }
        return summary.length > 0;

    } catch (err) {
        logWarn('好友', `巡查异常: ${err.message}`);
        return false;
    } finally {
        isCheckingFriends = false;
    }
}

/**
 * 好友巡查循环 - 本次完成后等待指定秒数再开始下次
 */
async function friendCheckLoop() {
    if (externalSchedulerMode) return;
    if (!friendLoopRunning) return;
    await checkFriends();
    if (!friendLoopRunning) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, CONFIG.friendCheckInterval), () => friendCheckLoop());
}

function startFriendCheckLoop(options = {}) {
    if (friendLoopRunning) return;
    externalSchedulerMode = !!options.externalScheduler;
    friendLoopRunning = true;

    // 注册操作限制更新回调，从农场检查中获取限制信息
    setOperationLimitsCallback(updateOperationLimits);

    // 监听好友申请推送 (微信同玩)
    networkEvents.on('friendApplicationReceived', onFriendApplicationReceived);

    if (!externalSchedulerMode) {
        // 延迟 5 秒后启动循环，等待登录和首次农场检查完成
        friendScheduler.setTimeoutTask('friend_check_loop', 5000, () => friendCheckLoop());
    }

    // 启动时检查一次待处理的好友申请
    friendScheduler.setTimeoutTask('friend_check_bootstrap_applications', 3000, () => checkAndAcceptApplications());
}

function stopFriendCheckLoop() {
    friendLoopRunning = false;
    externalSchedulerMode = false;
    invalidKnownFriendGidCooldownUntil.clear();
    networkEvents.off('friendApplicationReceived', onFriendApplicationReceived);
    friendScheduler.clearAll();
}

function refreshFriendCheckLoop(delayMs = 200) {
    if (!friendLoopRunning || externalSchedulerMode) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, delayMs), () => friendCheckLoop());
}

// ============ 自动同意好友申请 (微信同玩) ============

/**
 * 处理服务器推送的好友申请
 */
function onFriendApplicationReceived(applications) {
    const names = applications.map(a => a.name || `GID:${toNum(a.gid)}`).join(', ');
    log('申请', `收到 ${applications.length} 个好友申请: ${names}`);

    // 自动同意
    const gids = applications.map(a => toNum(a.gid));
    acceptFriendsWithRetry(gids);
}

/**
 * 获取待处理的好友申请列表
 */
async function getApplications() {
    const body = types.GetApplicationsRequest.encode(types.GetApplicationsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetApplications', body);
    return types.GetApplicationsReply.decode(replyBody);
}

/**
 * 检查并同意所有待处理的好友申请
 */
async function checkAndAcceptApplications() {
    try {
        const reply = await getApplications();
        const applications = reply.applications || [];
        if (applications.length === 0) return;

        const names = applications.map(a => a.name || `GID:${toNum(a.gid)}`).join(', ');
        log('申请', `发现 ${applications.length} 个待处理申请: ${names}`);

        const gids = applications.map(a => toNum(a.gid));
        await acceptFriendsWithRetry(gids);
    } catch {
        // 静默失败，可能是 QQ 平台不支持
    }
}

/**
 * 同意好友申请 (带重试)
 */
async function acceptFriendsWithRetry(gids) {
    if (gids.length === 0) return;
    try {
        const reply = await acceptFriends(gids);
        const friends = reply.friends || [];
        if (friends.length > 0) {
            const names = friends.map(f => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
            log('申请', `已同意 ${friends.length} 人: ${names}`);
        }
    } catch (e) {
        logWarn('申请', `同意失败: ${e.message}`);
    }
}

// ============ 启动时执行一次放虫放草 ============

let badExecutedOnStartup = false;

async function runBadOnceOnStartup() {
    if (badExecutedOnStartup) {
       // log('好友', '启动时放虫放草已执行过，跳过', { module: 'friend', event: '启动放虫放草跳过' });
        return;
    }

    const autoBadEnabled = isAutomationOn('friend_bad');
    if (!autoBadEnabled) {
      //  log('好友', '放虫放草功能未开启，跳过', { module: 'friend', event: '放虫放草未开启' });
        return;
    }

    const state = getUserState();
    if (!state.gid) {
        log('好友', '用户未登录，无法执行放虫放草', { module: 'friend', event: '放虫放草未登录' });
        return;
    }

    const accountId = process.env.FARM_ACCOUNT_ID || '';

    log('好友', '========== 启动时放虫放草开始 ==========', { module: 'friend', event: '启动放虫放草开始' });

    try {
        const friendsReply = await getAllFriends();
        const friends = extractReplyFriends(friendsReply);
        if (friends.length === 0) {
            log('好友', '没有好友，放虫放草结束', { module: 'friend', event: '没有游戏好友' });
            return;
        }

        const blacklist = new Set(getFriendBlacklist(accountId));
        const badFriends = [];
        const visitedGids = new Set();

        // 筛选可捣乱的好友（排除成熟植物的好友）
        for (const f of friends) {
            const gid = toNum(f.gid);
            if (gid === state.gid) continue;
            if (visitedGids.has(gid)) continue;
            if (blacklist.has(gid)) continue;

            const name = f.remark || f.name || `GID:${gid}`;
            const p = f.plant;
            const stealNum = p ? toNum(p.steal_plant_num) : 0;
            const dryNum = p ? toNum(p.dry_num) : 0;
            const weedNum = p ? toNum(p.weed_num) : 0;
            const insectNum = p ? toNum(p.insect_num) : 0;

            // 只有没有可偷、可帮助的好友才考虑捣乱
            if (stealNum === 0 && dryNum === 0 && weedNum === 0 && insectNum === 0) {
                const level = toNum(f.level);
                badFriends.push({ gid, name, level });
            }

            visitedGids.add(gid);
        }

        // 按等级降序排序，优先处理等级高的好友
        badFriends.sort((a, b) => b.level - a.level);

        // 只取等级最高的前20个
        const topBadFriends = badFriends.slice(0, 20);
        log('好友', `找到 ${badFriends.length} 个可捣乱的好友，处理等级最高的前${topBadFriends.length}个`, { module: 'friend', event: '放虫放草好友列表', totalCount: badFriends.length, topCount: topBadFriends.length });

        const totalActions = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
        let processedCount = 0;

        for (let i = 0; i < topBadFriends.length; i++) {
            const friend = topBadFriends[i];

            // 检查是否还有捣乱次数（共享额度 10003）
            if (isBadOperationLimitReached() || getRemainingBadOperationTimes() <= 0) {
                log('好友', `放虫放草次数已用完，停止执行。已处理 ${processedCount} 个好友`, { module: 'friend', event: '放虫放草次数用完', processedCount });
                break;
            }

            log('好友', `启动时放虫放草 ${i + 1}/${topBadFriends.length}: ${friend.name} (等级${friend.level})`, { module: 'friend', event: '放虫放草处理好友', index: i + 1, total: topBadFriends.length, friendName: friend.name, level: friend.level });

            try {
                // 使用 visitFriend 函数，类似 V1 版本逻辑
                await visitFriend(friend, totalActions, state.gid);
                processedCount++;
            } catch (e) {
                log('好友', `放虫放草失败: ${friend.name}, 错误: ${e.message}`, { module: 'friend', event: '放虫放草失败', friendName: friend.name, error: e.message });
            }

            await randomDelay(2000, 3500);
        }

        badExecutedOnStartup = true;

        const summary = [];
        if (totalActions.putBug > 0) summary.push(`放虫${totalActions.putBug}`);
        if (totalActions.putWeed > 0) summary.push(`放草${totalActions.putWeed}`);

        log('好友', `========== 启动时放虫放草结束 ========== 处理${processedCount}人${summary.length > 0 ? ` → ${  summary.join('/')}` : ''}`, { module: 'friend', event: '启动放虫放草结束', processedCount, summary });

    } catch (err) {
        logWarn('好友', `启动时放虫放草异常: ${err.message}`);
    }
}

// 检查帮助经验是否已达上限（用于外部判断是否需要执行帮助巡查）
function isHelpExpLimitReached() {
    return helpAutoDisabledByLimit;
}

function clearFriendsListCache() {
    friendsListCache = null;
    friendsListCacheTime = 0;
}

module.exports = {
    checkFriends, startFriendCheckLoop, stopFriendCheckLoop,
    refreshFriendCheckLoop,
    // checkAndAcceptApplications,
    runBadOnceOnStartup,
    isHelpExpLimitReached,
    getOperationLimits,
    getFriendsList,
    getFriendLandsDetail,
    doFriendOperation,
    clearFriendsListCache,
};
