/**
 * 好友农场操作 - 进入/离开/帮忙/偷菜/巡查
 */

const { CONFIG, PlantPhase } = require('../config/config');
const {
    isAutomationOn,
    getFriendBlacklist,
    getPlantBlacklist,
} = require('../models/store');
const { sendMsgAsync, getUserState, networkEvents } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, sleep, randomDelay } = require('../utils/utils');
const { getCurrentPhase, setOperationLimitsCallback } = require('./farm');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');
const { sellAllFruits } = require('./warehouse');
const { BAD_SHARED_LIMIT_ID, friendOperationLimits } = require('./friend-operation-limits');
const { analyzeFriendLands, buildFriendLandsDetail } = require('./friend-land-domain');
const {
    clearFriendDirectoryRuntimeState,
    clearFriendsListCache,
    extractReplyFriends,
    getAllFriends,
    getFriendsList,
    handleFriendEnterError,
    inFriendQuietHours,
} = require('./friend-directory');

const {
    autoDisableHelpByExpLimit,
    canGetExpByCandidates,
    canGetHelpExperience,
    canOperate,
    checkDailyReset,
    getOperationLimits,
    getRemainingBadOperationTimes,
    isBadOperationLimitReached,
    isHelpExpLimitReached,
    markBadOperationLimitReached,
    resetHelpExpAvailability,
    updateOperationLimits,
} = friendOperationLimits;

type DynamicRecord = Record<string, any>;
type FriendOperationTotals = Record<string, number>;

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

// ============ 内部状态 ============
let isCheckingFriends = false;
let friendLoopRunning = false;
let externalSchedulerMode = false;
const friendScheduler = createScheduler('friend');

async function acceptFriends(gids: unknown[]): Promise<DynamicRecord> {
    const body = types.AcceptFriendsRequest.encode(types.AcceptFriendsRequest.create({
        friend_gids: gids.map(g => toLong(g)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'AcceptFriends', body);
    return types.AcceptFriendsReply.decode(replyBody);
}

async function enterFriendFarm(friendGid: unknown): Promise<DynamicRecord> {
    const body = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
        host_gid: toLong(friendGid),
        reason: 2,  // ENTER_REASON_FRIEND
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body);
    return types.VisitEnterReply.decode(replyBody);
}

async function leaveFriendFarm(friendGid: unknown): Promise<void> {
    const body = types.VisitLeaveRequest.encode(types.VisitLeaveRequest.create({
        host_gid: toLong(friendGid),
    })).finish();
    try {
        await sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', body);
    } catch { /* 离开失败不影响主流程 */ }
}

async function helpWater(friendGid: unknown, landIds: unknown[], stopWhenExpLimit = false): Promise<DynamicRecord> {
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

async function helpWeed(friendGid: unknown, landIds: unknown[], stopWhenExpLimit = false): Promise<DynamicRecord> {
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

async function helpInsecticide(friendGid: unknown, landIds: unknown[], stopWhenExpLimit = false): Promise<DynamicRecord> {
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

async function stealHarvest(friendGid: unknown, landIds: unknown[]): Promise<DynamicRecord> {
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

async function putPlantItems(
    friendGid: unknown,
    landIds: unknown[],
    RequestType: DynamicRecord,
    ReplyType: DynamicRecord,
    method: string,
): Promise<number> {
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
            const message = errorMessage(e);
            if (message.includes('1001046')) {
                markBadOperationLimitReached(method);
                log('好友', `放虫/放草次数已达上限，停止执行`, { module: 'friend', event: '放虫放草次数上限' });
                break; // 次数用完，立即停止
            }
            // 记录其他错误
            log('好友', `放虫/放草失败: landId=${landId}, 错误: ${message}`, { module: 'friend', event: '放虫放草失败', landId, error: message });
            await randomDelay(2000, 3500);
        }
        if (ok > 0) {
            await randomDelay(2000, 3500);
        }
    }
    return ok;
}

async function putPlantItemsDetailed(
    friendGid: unknown,
    landIds: unknown[],
    RequestType: DynamicRecord,
    ReplyType: DynamicRecord,
    method: string,
): Promise<DynamicRecord> {
    let ok = 0;
    const failed: DynamicRecord[] = [];
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
            const message = errorMessage(e);
            if (message.includes('1001046')) {
                markBadOperationLimitReached(method);
                failed.push(...ids.slice(index).map(id => ({ landId: id, reason: '今日放虫/放草次数已达上限' })));
                break;
            }
            failed.push({ landId, reason: message || '未知错误' });
        }
        // 逐块节奏（含失败），防服务端软限流
        await randomDelay(2000, 3500);
    }
    return { ok, failed };
}

async function putInsects(friendGid: unknown, landIds: unknown[]): Promise<number> {
    return putPlantItems(friendGid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
}

async function putWeeds(friendGid: unknown, landIds: unknown[]): Promise<number> {
    return putPlantItems(friendGid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
}

async function putInsectsDetailed(friendGid: unknown, landIds: unknown[]): Promise<DynamicRecord> {
    return putPlantItemsDetailed(friendGid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
}

async function putWeedsDetailed(friendGid: unknown, landIds: unknown[]): Promise<DynamicRecord> {
    return putPlantItemsDetailed(friendGid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
}

async function checkCanOperateRemote(friendGid: unknown, operationId: unknown): Promise<DynamicRecord> {
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

/**
 * 获取指定好友的农田详情 (进入-获取-离开)
 */
async function getFriendLandsDetail(friendGid: unknown) {
    try {
        const enterReply = await enterFriendFarm(friendGid);
        const lands = enterReply.lands || [];
        const state = getUserState();
        const plantBlacklist = getPlantBlacklist(state.accountId);
        const analyzed = analyzeFriendLands(lands, state.gid, '', { plantBlacklist });
        await leaveFriendFarm(friendGid);

        return {
            lands: buildFriendLandsDetail(lands),
            summary: analyzed,
        };
    } catch {
        return { lands: [], summary: {} };
    }
}

async function runBatchWithFallback(
    ids: number[],
    batchFn: (ids: number[]) => Promise<unknown>,
    singleFn: (ids: number[]) => Promise<unknown>,
): Promise<number> {
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
async function doFriendOperation(friendGid: unknown, opType: string) {
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
        return { ok: false, message: `进入好友农场失败: ${errorMessage(e)}`, opType };
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
            count = await runBatchWithFallback(target, (ids: number[]) => stealHarvest(gid, ids), (ids: number[]) => stealHarvest(gid, ids));
            if (count > 0) {
                recordOperation('steal', count);
                // 手动偷取成功后立即尝试出售一次果实
                try {
                    await sellAllFruits();
                } catch (e) {
                    logWarn('仓库', `手动偷取后自动出售失败: ${errorMessage(e)}`, {
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
            count = await runBatchWithFallback(status.needWater, (ids: number[]) => helpWater(gid, ids), (ids: number[]) => helpWater(gid, ids));
            if (count > 0) recordOperation('helpWater', count);
            return { ok: true, opType, count, message: `浇水完成 ${count} 块` };
        }

        if (opType === 'weed') {
            if (!status.needWeed.length) return { ok: true, opType, count: 0, message: '没有可除草土地' };
            const precheck = await checkCanOperateRemote(gid, 10005);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '除草失败，来晚一步，可惜' };
            count = await runBatchWithFallback(status.needWeed, (ids: number[]) => helpWeed(gid, ids), (ids: number[]) => helpWeed(gid, ids));
            if (count > 0) recordOperation('helpWeed', count);
            return { ok: true, opType, count, message: `除草完成 ${count} 块` };
        }

        if (opType === 'bug') {
            if (!status.needBug.length) return { ok: true, opType, count: 0, message: '没有可除虫土地' };
            const precheck = await checkCanOperateRemote(gid, 10006);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '除虫失败，来晚一步，可惜' };
            count = await runBatchWithFallback(status.needBug, (ids: number[]) => helpInsecticide(gid, ids), (ids: number[]) => helpInsecticide(gid, ids));
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
            let failDetails: string[] = [];
            if (status.canPutWeed.length && !isBadOperationLimitReached()) {
                const weedRet = await putWeedsDetailed(gid, status.canPutWeed);
                weedCount = weedRet.ok;
                failDetails = failDetails.concat((weedRet.failed || []).map((failure: DynamicRecord) => `放草#${failure.landId}:${failure.reason}`));
                if (weedCount > 0) recordOperation('weed', weedCount);
            }
            if (status.canPutBug.length && !isBadOperationLimitReached()) {
                const bugRet = await putInsectsDetailed(gid, status.canPutBug);
                bugCount = bugRet.ok;
                failDetails = failDetails.concat((bugRet.failed || []).map((failure: DynamicRecord) => `放虫#${failure.landId}:${failure.reason}`));
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
        return { ok: false, opType, count: 0, message: errorMessage(e) || '操作失败' };
    } finally {
        try { await leaveFriendFarm(gid); } catch { /* ignore */ }
    }
}

// ============ 拜访好友 ============

async function visitFriend(
    friend: DynamicRecord,
    totalActions: FriendOperationTotals,
    myGid: unknown,
    accountId?: unknown,
) {
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
        logWarn('好友', `进入 ${name} 农场失败: ${errorMessage(e)}`, {
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
    const actions: string[] = [];

    // 1. 帮助操作 (除草/除虫/浇水)
    const helpEnabled = !!isAutomationOn('friend_help');
    const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit');
    if (!stopWhenExpLimit) resetHelpExpAvailability();
    if (!helpEnabled) {
        // 自动帮忙关闭，直接跳过帮助操作
    } else if (stopWhenExpLimit && !canGetHelpExperience()) {
        // 今日已达到经验上限后停止帮忙
    } else {
        const helpOps = [
            { id: 10005, expIds: [10005, 10003], list: status.needWeed, fn: helpWeed, key: 'weed', name: '草', record: 'helpWeed' },
            { id: 10006, expIds: [10006, 10002], list: status.needBug, fn: helpInsecticide, key: 'bug', name: '虫', record: 'helpBug' },
            { id: 10007, expIds: [10007, 10001], list: status.needWater, fn: helpWater, key: 'water', name: '水', record: 'helpWater' }
        ];

        for (const op of helpOps) {
            const allowByExp = (!stopWhenExpLimit) || (canGetExpByCandidates(op.expIds) && canGetHelpExperience());
            if (op.list.length > 0 && allowByExp) {
                const precheck = await checkCanOperateRemote(gid, op.id);
                if (precheck.canOperate) {
                    const count = await runBatchWithFallback(
                        op.list,
                        (ids: number[]) => op.fn(gid, ids, stopWhenExpLimit),
                        (ids: number[]) => op.fn(gid, ids, stopWhenExpLimit)
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
            const stolenPlants: string[] = [];
            
            // 尝试批量偷取
            try {
                await stealHarvest(gid, targetLands);
                ok = targetLands.length;
                targetLands.forEach((id: number) => {
                    const info = status.stealableInfo.find((entry: DynamicRecord) => entry.landId === id);
                    if (info) stolenPlants.push(info.name);
                });
            } catch {
                // 批量失败，降级为单个
                for (const landId of targetLands) {
                    try {
                        await stealHarvest(gid, [landId]);
                        ok++;
                        const info = status.stealableInfo.find((entry: DynamicRecord) => entry.landId === landId);
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

async function visitFriendForSteal(
    friend: DynamicRecord,
    totalActions: FriendOperationTotals,
    myGid: unknown,
    accountId: unknown,
) {
    const { gid, name } = friend;

    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    } catch (e) {
        const handled = handleFriendEnterError(gid, name, e);
        if (handled.handled) {
            return { acted: false, entered: false };
        }
        logWarn('好友', `进入 ${name} 农场失败: ${errorMessage(e)}`, {
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

    const actions: string[] = [];

    // 检查是否所有可偷蔬菜都被黑名单过滤了（只统计成熟的、可偷的植物）
    const hasStealableBeforeFilter = lands.some((land: DynamicRecord) => {
        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) return false;
        const currentPhase = getCurrentPhase(land.plant.phases, false);
        if (!currentPhase || currentPhase.phase !== PlantPhase.MATURE) return false;
        if (!plant.stealable) return false;
        const stealInfo = plant.steal_player;
        if (!stealInfo || stealInfo.length === 0) return true; // 无人偷过，可偷
        const mySteal = stealInfo.find((entry: DynamicRecord) => toNum(entry.gid) === myGid);
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
            const stolenPlants: string[] = [];

            // 尝试批量偷取
            try {
                await stealHarvest(gid, targetLands);
                ok = targetLands.length;
                targetLands.forEach((id: number) => {
                    const info = status.stealableInfo.find((entry: DynamicRecord) => entry.landId === id);
                    if (info) stolenPlants.push(info.name);
                });
            } catch {
                // 批量失败，降级为单个
                for (const landId of targetLands) {
                    try {
                        await stealHarvest(gid, [landId]);
                        ok++;
                        const info = status.stealableInfo.find((entry: DynamicRecord) => entry.landId === landId);
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

async function visitFriendForHelp(
    friend: DynamicRecord,
    totalActions: FriendOperationTotals,
    myGid: unknown,
    accountId: unknown,
    ignoreExpLimit = false,
) {
    const { gid, name } = friend;

    const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
    if (!stopWhenExpLimit) resetHelpExpAvailability();
    if (stopWhenExpLimit && !canGetHelpExperience()) {
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
        logWarn('好友', `进入 ${name} 农场失败: ${errorMessage(e)}`, {
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

    const actions: string[] = [];

    const helpOps = [
        { id: 10005, expIds: [10005, 10003], list: status.needWeed, fn: helpWeed, key: 'weed', name: '草', record: 'helpWeed' },
        { id: 10006, expIds: [10006, 10002], list: status.needBug, fn: helpInsecticide, key: 'bug', name: '虫', record: 'helpBug' },
        { id: 10007, expIds: [10007, 10001], list: status.needWater, fn: helpWater, key: 'water', name: '水', record: 'helpWater' }
    ];

    for (const op of helpOps) {
        const allowByExp = (!stopWhenExpLimit) || (canGetExpByCandidates(op.expIds) && canGetHelpExperience());
        if (op.list.length > 0 && allowByExp) {
            const precheck = await checkCanOperateRemote(gid, op.id);
            if (precheck.canOperate) {
                const count = await runBatchWithFallback(
                    op.list,
                    (ids: number[]) => op.fn(gid, ids, stopWhenExpLimit),
                    (ids: number[]) => op.fn(gid, ids, stopWhenExpLimit)
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

async function checkFriends(options: {
    onlyHelp?: boolean;
    onlySteal?: boolean;
    onlyBad?: boolean;
    ignoreExpLimit?: boolean;
} = {}): Promise<boolean> {
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

        const stealFriends: DynamicRecord[] = [];
        const helpFriends: DynamicRecord[] = [];
        const visitedGids = new Set<number>();

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

        const totalActions: FriendOperationTotals = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };

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
                if (stopWhenExpLimit && !canGetHelpExperience()) {
                    log('好友', `批量帮助中断：经验已达上限`, { module: 'friend', event: '批量帮助中断', reason: 'exp_limit' });
                    break;
                }

                try {
                    // await visitFriendForHelp(friend, totalActions, state.gid, state.accountId);
                    await visitFriendForHelp(friend, totalActions, state.gid, state.accountId, ignoreExpLimit);
                    log('好友', `批量帮助第 ${i + 1} 个好友完成: ${friend.name}`, { module: 'friend', event: '批量帮助完成', index: i + 1, friendName: friend.name });
                } catch (e) {
                    const message = errorMessage(e);
                    log('好友', `批量帮助第 ${i + 1} 个好友失败: ${friend.name}, 错误: ${message}`, { module: 'friend', event: '批量帮助失败', index: i + 1, friendName: friend.name, error: message });
                }
                await randomDelay(500, 800);
            }
            log('好友', '批量帮助循环结束', { module: 'friend', event: '批量帮助结束' });
        }

        // 第四阶段：批量捣乱（放虫放草）
        if (effectiveBadEnabled) {
            log('好友', '开始自动放虫放草', { module: 'friend', event: '开始自动放虫放草' });
            
            const badFriends: DynamicRecord[] = [];
            const badVisitedGids = new Set<number>();
            
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
        const summary: string[] = [];
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
        logWarn('好友', `巡查异常: ${errorMessage(err)}`);
        return false;
    } finally {
        isCheckingFriends = false;
    }
}

/**
 * 好友巡查循环 - 本次完成后等待指定秒数再开始下次
 */
async function friendCheckLoop(): Promise<void> {
    if (externalSchedulerMode) return;
    if (!friendLoopRunning) return;
    await checkFriends();
    if (!friendLoopRunning) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, CONFIG.friendCheckInterval), () => friendCheckLoop());
}

function startFriendCheckLoop(options: { externalScheduler?: boolean } = {}): void {
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

function stopFriendCheckLoop(): void {
    friendLoopRunning = false;
    externalSchedulerMode = false;
    clearFriendDirectoryRuntimeState();
    networkEvents.off('friendApplicationReceived', onFriendApplicationReceived);
    friendScheduler.clearAll();
}

function refreshFriendCheckLoop(delayMs = 200): void {
    if (!friendLoopRunning || externalSchedulerMode) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, delayMs), () => friendCheckLoop());
}

// ============ 自动同意好友申请 (微信同玩) ============

/**
 * 处理服务器推送的好友申请
 */
function onFriendApplicationReceived(applications: DynamicRecord[]): void {
    const names = applications.map((application: DynamicRecord) => application.name || `GID:${toNum(application.gid)}`).join(', ');
    log('申请', `收到 ${applications.length} 个好友申请: ${names}`);

    // 自动同意
    const gids = applications.map((application: DynamicRecord) => toNum(application.gid));
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

        const names = applications.map((application: DynamicRecord) => application.name || `GID:${toNum(application.gid)}`).join(', ');
        log('申请', `发现 ${applications.length} 个待处理申请: ${names}`);

        const gids = applications.map((application: DynamicRecord) => toNum(application.gid));
        await acceptFriendsWithRetry(gids);
    } catch {
        // 静默失败，可能是 QQ 平台不支持
    }
}

/**
 * 同意好友申请 (带重试)
 */
async function acceptFriendsWithRetry(gids: unknown[]): Promise<void> {
    if (gids.length === 0) return;
    try {
        const reply = await acceptFriends(gids);
        const friends = reply.friends || [];
        if (friends.length > 0) {
            const names = friends.map((friend: DynamicRecord) => friend.name || friend.remark || `GID:${toNum(friend.gid)}`).join(', ');
            log('申请', `已同意 ${friends.length} 人: ${names}`);
        }
    } catch (e) {
        logWarn('申请', `同意失败: ${errorMessage(e)}`);
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
        const badFriends: DynamicRecord[] = [];
        const visitedGids = new Set<number>();

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

        const totalActions: FriendOperationTotals = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
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
                const message = errorMessage(e);
                log('好友', `放虫放草失败: ${friend.name}, 错误: ${message}`, { module: 'friend', event: '放虫放草失败', friendName: friend.name, error: message });
            }

            await randomDelay(2000, 3500);
        }

        badExecutedOnStartup = true;

        const summary: string[] = [];
        if (totalActions.putBug > 0) summary.push(`放虫${totalActions.putBug}`);
        if (totalActions.putWeed > 0) summary.push(`放草${totalActions.putWeed}`);

        log('好友', `========== 启动时放虫放草结束 ========== 处理${processedCount}人${summary.length > 0 ? ` → ${  summary.join('/')}` : ''}`, { module: 'friend', event: '启动放虫放草结束', processedCount, summary });

    } catch (err) {
        logWarn('好友', `启动时放虫放草异常: ${errorMessage(err)}`);
    }
}

export {
    checkFriends,
    clearFriendsListCache,
    doFriendOperation,
    getFriendLandsDetail,
    getFriendsList,
    getOperationLimits,
    isHelpExpLimitReached,
    refreshFriendCheckLoop,
    runBadOnceOnStartup,
    startFriendCheckLoop,
    stopFriendCheckLoop,
};
