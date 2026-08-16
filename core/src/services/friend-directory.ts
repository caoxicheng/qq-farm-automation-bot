/**
 * 好友目录同步、缓存与访问错误处理。
 */

const { parentPort } = require('node:worker_threads');
const { CONFIG } = require('../config/config');
const {
    applyConfigSnapshot,
    getFriendBlacklist,
    getFriendQuietHours,
    getFriendsListCacheTtlSec,
    getKnownFriendGids,
    getKnownFriendGidSyncCooldownSec,
} = require('../models/store');
const { getUserState, sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, logWarn, randomDelay, toLong, toNum } = require('../utils/utils');
const { getInteractRecords } = require('./interact');

type DynamicRecord = Record<string, any>;

const QQ_FRIEND_LIST_BATCH_SIZE = 35;
const DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const MIN_QQ_VISITOR_GID_SYNC_RETRY_MS = 30 * 1000;
const MAX_QQ_VISITOR_GID_SYNC_RETRY_MS = 2 * 60 * 1000;
const INVALID_KNOWN_FRIEND_GID_COOLDOWN_MS = 24 * 60 * 60 * 1000;

let friendsListCache: DynamicRecord[] | null = null;
let friendsListCacheTime = 0;
let lastVisitorGidSyncAt = 0;
const invalidKnownFriendGidCooldownUntil = new Map<number, number>();

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function postToMaster(payload: unknown): boolean {
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

export function normalizeFriendGids(values: unknown): number[] {
    const normalized: number[] = [];
    for (const item of (Array.isArray(values) ? values : [])) {
        const value = toNum(item);
        if (value <= 0 || normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

export function extractReplyFriends(reply: DynamicRecord | null | undefined): DynamicRecord[] {
    if (Array.isArray(reply?.game_friends)) return reply.game_friends;
    if (Array.isArray(reply?.gameFriends)) return reply.gameFriends;
    return [];
}

export function dedupeFriendsByGid(friends: unknown): DynamicRecord[] {
    const result: DynamicRecord[] = [];
    const seen = new Set<number>();
    for (const friend of (Array.isArray(friends) ? friends : [])) {
        const gid = toNum(friend?.gid);
        if (gid <= 0 || seen.has(gid)) continue;
        seen.add(gid);
        result.push(friend);
    }
    return result;
}

export function buildFriendReply(friends: unknown): DynamicRecord {
    const list = dedupeFriendsByGid(friends);
    return { game_friends: list, gameFriends: list };
}

function getFriendsListCacheTtlMs(): number {
    const sec = Number(getFriendsListCacheTtlSec?.() || 0);
    if (!Number.isFinite(sec) || sec <= 0) return 60 * 1000;
    return Math.max(10 * 1000, sec * 1000);
}

function pruneInvalidKnownFriendGidCooldown(nowMs = Date.now()): void {
    for (const [gid, until] of invalidKnownFriendGidCooldownUntil.entries()) {
        if (!gid || until <= nowMs) invalidKnownFriendGidCooldownUntil.delete(gid);
    }
}

function clearInvalidKnownFriendGidMarks(gids: unknown): void {
    for (const gid of normalizeFriendGids(gids)) invalidKnownFriendGidCooldownUntil.delete(gid);
}

function markKnownFriendGidInvalid(friendGid: unknown, nowMs = Date.now()): void {
    const gid = toNum(friendGid);
    if (gid > 0) invalidKnownFriendGidCooldownUntil.set(gid, nowMs + INVALID_KNOWN_FRIEND_GID_COOLDOWN_MS);
}

function getInvalidKnownFriendGidSet(nowMs = Date.now()): Set<number> {
    pruneInvalidKnownFriendGidCooldown(nowMs);
    return new Set(invalidKnownFriendGidCooldownUntil.keys());
}

function getKnownFriendGidSyncIntervalMs(): number {
    const sec = Number(getKnownFriendGidSyncCooldownSec?.() || 0);
    if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS;
    return Math.max(30 * 1000, sec * 1000);
}

function getKnownFriendGidSyncRetryMs(): number {
    return Math.max(
        MIN_QQ_VISITOR_GID_SYNC_RETRY_MS,
        Math.min(getKnownFriendGidSyncIntervalMs(), MAX_QQ_VISITOR_GID_SYNC_RETRY_MS),
    );
}

function syncKnownFriendGidsFromFriends(friends: DynamicRecord[]): number[] {
    const fetchedGids = normalizeFriendGids(friends.map(friend => friend?.gid));
    if (fetchedGids.length === 0) return [];
    clearInvalidKnownFriendGidMarks(fetchedGids);

    const current = normalizeFriendGids(getKnownFriendGids());
    const merged = normalizeFriendGids([...current, ...fetchedGids]);
    if (merged.length === current.length && merged.every((gid, index) => gid === current[index])) return merged;

    applyConfigSnapshot({ knownFriendGids: merged }, { persist: false });
    if (!postToMaster({ type: 'known_friend_gids_sync', gids: merged })) {
        applyConfigSnapshot({ knownFriendGids: merged }, { persist: true });
    }
    return merged;
}

function getEffectiveKnownQqFriendGids(): number[] {
    const currentKnownGids = normalizeFriendGids(getKnownFriendGids());
    clearInvalidKnownFriendGidMarks(currentKnownGids);
    const invalidGidSet = getInvalidKnownFriendGidSet();
    const blacklistSet = new Set(getFriendBlacklist(process.env.FARM_ACCOUNT_ID || ''));
    return currentKnownGids.filter(gid => !invalidGidSet.has(gid) && !blacklistSet.has(gid));
}

async function syncKnownFriendGidsFromRecentVisitors(force = false): Promise<number[]> {
    const now = Date.now();
    const interval = lastVisitorGidSyncAt > 0 ? getKnownFriendGidSyncIntervalMs() : 0;
    if (!force && interval > 0 && now - lastVisitorGidSyncAt < interval) return getEffectiveKnownQqFriendGids();

    const accountId = process.env.FARM_ACCOUNT_ID || '';
    try {
        const records = await getInteractRecords();
        const invalidGidSet = getInvalidKnownFriendGidSet(now);
        const visitorGids = normalizeFriendGids(
            (Array.isArray(records) ? records : []).map(record => record?.visitorGid),
        ).filter(gid => !invalidGidSet.has(gid));
        lastVisitorGidSyncAt = now;
        if (visitorGids.length === 0) return getEffectiveKnownQqFriendGids();

        const current = normalizeFriendGids(getKnownFriendGids());
        const merged = normalizeFriendGids([...current, ...visitorGids]);
        const addedCount = merged.filter(gid => !current.includes(gid)).length;
        if (addedCount > 0) {
            applyConfigSnapshot({ knownFriendGids: merged }, { persist: false, accountId });
            if (!postToMaster({ type: 'known_friend_gids_sync', gids: merged })) {
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
        return normalizeFriendGids([...merged, ...getFriendBlacklist(accountId)]);
    } catch (error) {
        const retryMs = getKnownFriendGidSyncRetryMs();
        const intervalMs = getKnownFriendGidSyncIntervalMs();
        if (now - lastVisitorGidSyncAt >= retryMs) lastVisitorGidSyncAt = now - (intervalMs - retryMs);
        logWarn('好友', `同步最近访客 GID 失败: ${errorMessage(error)}`, {
            module: 'friend',
            event: '同步好友GID',
            result: 'error',
        });
        return getEffectiveKnownQqFriendGids();
    }
}

function removeKnownFriendGid(friendGid: unknown, friendName: unknown, reason = ''): boolean {
    const gid = toNum(friendGid);
    if (!gid) return false;
    const current = normalizeFriendGids(getKnownFriendGids());
    const next = current.filter(item => item !== gid);
    markKnownFriendGidInvalid(gid);
    if (next.length !== current.length) applyConfigSnapshot({ knownFriendGids: next }, { persist: false });

    const sent = postToMaster({
        type: 'known_friend_gid_remove',
        gid,
        friendName: friendName || `GID:${gid}`,
        reason: String(reason || ''),
    });
    if (!sent && next.length !== current.length) applyConfigSnapshot({ knownFriendGids: next }, { persist: true });

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

export function isEnterFarmBannedError(error: unknown): boolean {
    return errorMessage(error).includes('1002003');
}

function parseRpcErrorCode(error: unknown): number {
    const match = errorMessage(error).match(/code=(\d+)/i);
    return match ? (Number.parseInt(match[1], 10) || 0) : 0;
}

function isTransientNetworkError(error: unknown): boolean {
    const message = errorMessage(error);
    return [
        '连接未打开',
        '请求超时',
        '请求已中断',
        '连接关闭',
        '连接已在加密途中关闭',
        'worker exited',
    ].some(keyword => message.includes(keyword));
}

export function isInvalidFriendAccessError(error: unknown): boolean {
    const message = errorMessage(error);
    if (!message || isEnterFarmBannedError(error) || isTransientNetworkError(error)) return false;
    const lowerMessage = message.toLowerCase();
    const hasInvalidKeyword = ['无效', '不存在', '删除', '关系', 'not found', 'invalid', 'not friend', 'friend']
        .some(keyword => lowerMessage.includes(keyword.toLowerCase()));
    return hasInvalidKeyword && parseRpcErrorCode(error) > 0;
}

function addFriendToBlacklist(friendGid: unknown, friendName: unknown, reason = ''): boolean {
    const gid = toNum(friendGid);
    if (!gid) return false;
    const current = getFriendBlacklist(process.env.FARM_ACCOUNT_ID || '');
    if (Array.isArray(current) && current.includes(gid)) return false;
    if (!postToMaster({
        type: 'friend_blacklist_add',
        gid,
        friendName: friendName || `GID:${gid}`,
        reason: String(reason || ''),
    })) return false;

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

export function handleFriendEnterError(friendGid: unknown, friendName: unknown, error: unknown): DynamicRecord {
    const gid = toNum(friendGid);
    const displayName = String(friendName || '').trim() || `GID:${gid}`;
    const reason = errorMessage(error);
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

async function fetchQqFriendsByKnownGids(): Promise<DynamicRecord[]> {
    if (!types.GetGameFriendsRequest || !types.GetAllFriendsReply) throw new Error('GetGameFriends 接口类型未加载');
    const knownGids = getEffectiveKnownQqFriendGids();
    if (knownGids.length === 0) return [];

    const allFriends: DynamicRecord[] = [];
    for (let index = 0; index < knownGids.length; index += QQ_FRIEND_LIST_BATCH_SIZE) {
        const batch = knownGids.slice(index, index + QQ_FRIEND_LIST_BATCH_SIZE);
        const body = types.GetGameFriendsRequest.encode(types.GetGameFriendsRequest.create({
            gids: batch.map(gid => toLong(gid)),
        })).finish();
        try {
            const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetGameFriends', body);
            allFriends.push(...extractReplyFriends(types.GetAllFriendsReply.decode(replyBody)));
        } catch (error) {
            logWarn('好友', `QQ 新好友接口分批请求失败(${index + 1}-${index + batch.length}/${knownGids.length}): ${errorMessage(error)}`, {
                module: 'friend',
                event: '好友列表接口',
                result: 'error',
                method: 'GetGameFriends',
                batchSize: batch.length,
            });
        }
        if (index + QQ_FRIEND_LIST_BATCH_SIZE < knownGids.length) await randomDelay(500, 1000);
    }
    return dedupeFriendsByGid(allFriends);
}

async function fetchQqFriendsByLegacyMethod(): Promise<DynamicRecord[]> {
    const errors: string[] = [];
    try {
        const requestType = types.SyncAllRequest || types.SyncAllFriendsRequest;
        const replyType = types.SyncAllReply || types.SyncAllFriendsReply;
        if (!requestType || !replyType) throw new Error('SyncAll 接口类型未加载');
        const body = requestType.encode(requestType.create({ open_ids: [] })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'SyncAll', body);
        return extractReplyFriends(replyType.decode(replyBody));
    } catch (error) {
        errors.push(`SyncAll: ${errorMessage(error)}`);
    }
    try {
        if (!types.GetAllFriendsRequest || !types.GetAllFriendsReply) throw new Error('GetAll 接口类型未加载');
        const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body);
        return extractReplyFriends(types.GetAllFriendsReply.decode(replyBody));
    } catch (error) {
        errors.push(`GetAll: ${errorMessage(error)}`);
    }
    throw new Error(errors.join(' | '));
}

function parseTimeToMinutes(time: unknown): number | null {
    const match = String(time || '').match(/^(\d{1,2}):(\d{1,2})$/);
    if (!match) return null;
    const hour = Number.parseInt(match[1], 10);
    const minute = Number.parseInt(match[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
}

export function isWithinFriendQuietHours(config: DynamicRecord | null | undefined, now = new Date()): boolean {
    if (!config?.enabled) return false;
    const start = parseTimeToMinutes(config.start);
    const end = parseTimeToMinutes(config.end);
    if (start === null || end === null) return false;
    const current = now.getHours() * 60 + now.getMinutes();
    if (start === end) return true;
    if (start < end) return current >= start && current < end;
    return current >= start || current < end;
}

export function inFriendQuietHours(now = new Date()): boolean {
    return isWithinFriendQuietHours(getFriendQuietHours(), now);
}

export async function getAllFriends(forceSync = false): Promise<DynamicRecord> {
    if (CONFIG.platform === 'qq') {
        await syncKnownFriendGidsFromRecentVisitors(forceSync);
        const friendsFromKnownGids = await fetchQqFriendsByKnownGids();
        if (friendsFromKnownGids.length > 0) {
            syncKnownFriendGidsFromFriends(friendsFromKnownGids);
            return buildFriendReply(friendsFromKnownGids);
        }
        try {
            const legacyFriends = dedupeFriendsByGid(await fetchQqFriendsByLegacyMethod());
            if (legacyFriends.length > 0) syncKnownFriendGidsFromFriends(legacyFriends);
            else if (getEffectiveKnownQqFriendGids().length === 0) {
                logWarn('好友', 'QQ 好友列表为空；若近期接口已切到 GetGameFriends，请先在好友页维护已知好友 GID 列表', {
                    module: 'friend',
                    event: '好友列表接口',
                    result: 'empty',
                });
            }
            return buildFriendReply(legacyFriends);
        } catch (error) {
            if (getEffectiveKnownQqFriendGids().length === 0) {
                throw new Error(`QQ 好友列表获取失败，请先在好友页维护已知好友 GID 列表。${errorMessage(error)}`);
            }
            throw error;
        }
    }

    const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body);
    return types.GetAllFriendsReply.decode(replyBody);
}

export async function getFriendsList(forceSync = false): Promise<DynamicRecord[]> {
    try {
        const now = Date.now();
        if (!forceSync && friendsListCache && now - friendsListCacheTime < getFriendsListCacheTtlMs()) return friendsListCache;
        log('好友', '开始获取好友列表', { module: 'friend', event: '获取好友列表' });
        const friends = extractReplyFriends(await getAllFriends(forceSync));
        const state = getUserState();
        const result = friends
            .filter((friend: DynamicRecord) => toNum(friend.gid) !== state.gid && friend.name !== '小小农夫' && friend.remark !== '小小农夫')
            .map((friend: DynamicRecord) => ({
                gid: toNum(friend.gid),
                name: friend.remark || friend.name || `GID:${toNum(friend.gid)}`,
                avatarUrl: String(friend.avatar_url || '').trim(),
                level: toNum(friend.level),
                gold: toNum(friend.gold),
                plant: friend.plant ? {
                    stealNum: toNum(friend.plant.steal_plant_num),
                    dryNum: toNum(friend.plant.dry_num),
                    weedNum: toNum(friend.plant.weed_num),
                    insectNum: toNum(friend.plant.insect_num),
                } : null,
            }))
            .sort((left: DynamicRecord, right: DynamicRecord) => {
                const byName = String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN');
                return byName || Number(left.gid || 0) - Number(right.gid || 0);
            });
        friendsListCache = result;
        friendsListCacheTime = now;
        log('好友', `获取好友列表成功，共 ${result.length} 位好友`, {
            module: 'friend',
            event: '获取好友列表',
            result: 'ok',
            count: result.length,
        });
        return result;
    } catch (error) {
        const message = errorMessage(error);
        log('好友', `获取好友列表失败: ${message}`, {
            module: 'friend',
            event: '获取好友列表',
            result: 'error',
            error: message,
        });
        return [];
    }
}

export function clearFriendsListCache(): void {
    friendsListCache = null;
    friendsListCacheTime = 0;
}

export function clearFriendDirectoryRuntimeState(): void {
    invalidKnownFriendGidCooldownUntil.clear();
}
