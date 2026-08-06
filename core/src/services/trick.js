// 自动捣蛋：放虫/放草（好友农场恶作剧），每日合计上限（默认 100 次，服务端限制）
// 协议：PlantService.PutInsects / PutWeeds（host_gid + land_ids，抓包验证）
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log } = require('../utils/utils');
const { getAutomation } = require('../models/store');
const { getFriendsList } = require('./friend');

const FRIEND_LAND_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
const TRICK_OPERATION_INTERVAL_MS = 400;

// 内存计数（重启后由服务端 100 次限制兜底）
let trickRunDateKey = '';
let trickRunCount = 0;
let trickRetryTimer = null;

function getLocalDateKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function isTrickEnabled(accountId = 0) {
    return !!getAutomation(accountId).trick_enabled;
}

function getTrickDailyLimit(accountId = 0) {
    const v = Number(getAutomation(accountId).trick_daily_limit);
    // 服务端限制 100 次（草+虫合计），本地配置不超上限
    return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 100) : 100;
}

function getTrickDailyState() {
    return {
        dateKey: trickRunDateKey,
        count: trickRunCount,
        limit: getTrickDailyLimit(0),
    };
}

async function putInsects(hostGid, landIds) {
    // field_4=2 为抓包确认的操作类型（请求带 field 3=0/field 4=2）
    const req = types.PutInsectsRequest.create({ host_gid: hostGid, land_ids: landIds, field_4: 2 });
    const body = Buffer.from(types.PutInsectsRequest.encode(req).finish());
    // 短超时：服务端限流时快速跳过，避免循环卡死；1001046 = 今日捣蛋次数上限
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'PutInsects', body, { timeoutMs: 8000, expectedErrorCodes: [1001046] });
    return types.PutInsectsReply.decode(replyBody);
}

async function putWeeds(hostGid, landIds) {
    const req = types.PutWeedsRequest.create({ host_gid: hostGid, land_ids: landIds, field_4: 2 });
    const body = Buffer.from(types.PutWeedsRequest.encode(req).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'PutWeeds', body, { timeoutMs: 8000, expectedErrorCodes: [1001046] });
    return types.PutWeedsReply.decode(replyBody);
}

// 拜访好友农场（Enter 上下文是放虫/放草生效的前提）
async function enterFriendFarm(hostGid) {
    const req = types.VisitEnterRequest.create({ host_gid: hostGid, reason: 2 });
    const body = Buffer.from(types.VisitEnterRequest.encode(req).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body, { timeoutMs: 8000 });
    return types.VisitEnterReply.decode(replyBody);
}

async function leaveFriendFarm(hostGid) {
    try {
        const req = types.VisitLeaveRequest.create({ host_gid: hostGid });
        const body = Buffer.from(types.VisitLeaveRequest.encode(req).finish());
        await sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', body, { timeoutMs: 5000 });
    } catch { /* 离开失败不影响主流程 */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 自动捣蛋主流程：遍历好友地块，放虫+放草各一次（成功计次），到达上限立即停止
async function performDailyTrick(force = false, accountId = 0) {
    const limit = getTrickDailyLimit(accountId);
    const todayKey = getLocalDateKey();
    if (trickRunDateKey !== todayKey) {
        trickRunDateKey = todayKey;
        trickRunCount = 0;
    }
    if (!force && !isTrickEnabled(accountId)) return;
    if (trickRunCount >= limit) return;

    // 用好友缓存（好友巡查循环会定期刷新）；缓存空则跳过本次（等重试）
    const friendsList = await getFriendsList();
    const friends = Array.isArray(friendsList) ? friendsList : [];
    const gids = Array.from(new Set(friends.map((f) => Number(f && f.gid) || 0).filter((g) => g > 0)));
    if (!gids.length) {
        log('捣蛋', '无好友可捣蛋（5 分钟后重试）', { module: 'trick', event: 'trick_daily', result: 'no_friends', dev: true });
        // 好友缓存未就绪（登录初期）：5 分钟后重试一次（避免每日任务只跑一次导致错过）
        if (!trickRetryTimer) {
            trickRetryTimer = setTimeout(() => {
                trickRetryTimer = null;
                performDailyTrick(true, accountId).catch(() => null);
            }, 5 * 60 * 1000);
        }
        return;
    }

    log('捣蛋', `自动捣蛋开始：${gids.length} 个好友，今日 ${trickRunCount}/${limit} 次`, {
        module: 'trick', event: 'trick_daily', result: 'start', count: gids.length, dev: true,
    });

    let success = 0;
    let limitReached = false;
    for (const gid of gids) {
        if (trickRunCount >= limit || limitReached) break;

        // 拜访好友农场（放虫/放草生效的前提）
        try {
            await enterFriendFarm(gid);
        } catch {
            log('捣蛋', `拜访好友${gid}失败，跳过`, { module: 'trick', event: 'trick_enter', gid, result: 'error', dev: true });
            continue;
        }
        await sleep(TRICK_OPERATION_INTERVAL_MS);

        for (const landId of FRIEND_LAND_IDS) {
            if (trickRunCount >= limit || limitReached) break;

            // 放虫（同一块地一次）
            try {
                await putInsects(gid, [landId]);
                trickRunCount++;
                success++;
                log('捣蛋', `放虫 好友${gid} 地块${landId}（${trickRunCount}/${limit}）`, {
                    module: 'trick', event: 'put_insects', gid, landId, count: trickRunCount, dev: true,
                });
            } catch (e) {
                // 1001046 = 今日放虫/放草次数已达上限，立即停止
                if (e && e.code === 1001046) {
                    limitReached = true;
                    log('捣蛋', `今日捣蛋次数已达上限（1001046），停止`, { module: 'trick', event: 'trick_limit', result: 'limit_reached', dev: true });
                    break;
                }
                // 已放虫/无作物等：跳过该地块（不消耗次数）
            }
            await sleep(TRICK_OPERATION_INTERVAL_MS);
            if (trickRunCount >= limit || limitReached) break;

            // 放草（同一块地一次）
            try {
                await putWeeds(gid, [landId]);
                trickRunCount++;
                success++;
                log('捣蛋', `放草 好友${gid} 地块${landId}（${trickRunCount}/${limit}）`, {
                    module: 'trick', event: 'put_weeds', gid, landId, count: trickRunCount, dev: true,
                });
            } catch (e) {
                if (e && e.code === 1001046) {
                    limitReached = true;
                    log('捣蛋', `今日捣蛋次数已达上限（1001046），停止`, { module: 'trick', event: 'trick_limit', result: 'limit_reached', dev: true });
                    break;
                }
                // 已放草/无作物等：跳过该地块（不消耗次数）
            }
            await sleep(TRICK_OPERATION_INTERVAL_MS);
        }

        // 离开好友农场
        await leaveFriendFarm(gid);
        await sleep(TRICK_OPERATION_INTERVAL_MS * 2);
    }

    log('捣蛋', `自动捣蛋结束：成功 ${success} 次（今日 ${trickRunCount}/${limit}）`, {
        module: 'trick', event: 'trick_daily', result: 'done', success, count: trickRunCount, dev: true,
    });
}

module.exports = {
    performDailyTrick,
    putInsects,
    putWeeds,
    getTrickDailyState,
    isTrickEnabled,
    getTrickDailyLimit,
};
