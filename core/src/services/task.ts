/**
 * 任务系统 - 自动领取任务奖励
 */

const { isAutomationOn } = require('../models/store');
const { sendMsgAsync, networkEvents } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, sleep } = require('../utils/utils');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');
const { asRecord, errorMessage, recordArray } = require('./service-boundaries');

type TaskCategory = 'main' | 'daily' | 'growth';
type RewardLike = { id?: unknown; count?: unknown };
type ActiveRewardLike = { status?: unknown; point_id?: unknown };

interface RawTask {
    id?: unknown;
    desc?: string;
    progress?: unknown;
    total_progress?: unknown;
    is_claimed?: boolean;
    is_unlocked?: boolean;
    share_multiple?: unknown;
    rewards?: RewardLike[];
    task_type?: unknown;
}

interface ActiveLike {
    type?: unknown;
    rewards?: ActiveRewardLike[];
}

interface TaskInfoLike {
    daily_tasks: RawTask[];
    growth_tasks: RawTask[];
    tasks: RawTask[];
    actives: ActiveLike[];
}

interface FormattedTask {
    id: number;
    desc: string;
    category: TaskCategory;
    progress: number;
    totalProgress: number;
    isClaimed: boolean;
    isUnlocked: boolean;
    shareMultiple: number;
    rewards: Array<{ id: number; count: number }>;
    canClaim: boolean;
}

function normalizeRawTask(value: unknown): RawTask {
    const task = asRecord(value);
    return {
        id: task.id,
        desc: typeof task.desc === 'string' ? task.desc : undefined,
        progress: task.progress,
        total_progress: task.total_progress,
        is_claimed: task.is_claimed === true,
        is_unlocked: task.is_unlocked === true,
        share_multiple: task.share_multiple,
        rewards: recordArray(task.rewards),
        task_type: task.task_type,
    };
}

function normalizeTaskInfo(value: unknown): TaskInfoLike {
    const info = asRecord(value);
    return {
        daily_tasks: recordArray(info.daily_tasks).map(normalizeRawTask),
        growth_tasks: recordArray(info.growth_tasks).map(normalizeRawTask),
        tasks: recordArray(info.tasks).map(normalizeRawTask),
        actives: recordArray(info.actives).map((value: unknown) => {
            const active = asRecord(value);
            return {
                type: active.type,
                rewards: recordArray(active.rewards),
            };
        }),
    };
}

let checking = false;
let taskClaimDoneDateKey = '';
let taskClaimLastAt = 0;
const taskScheduler = createScheduler('task');

function getDateKey(): string {
    const { getServerTimeSec } = require('../utils/utils');
    const nowSec = getServerTimeSec();
    const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
    const bjOffset = 8 * 3600 * 1000;
    const bjDate = new Date(nowMs + bjOffset);
    const y = bjDate.getUTCFullYear();
    const m = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(bjDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ============ 任务 API ============

async function getTaskInfo(): Promise<{ task_info?: TaskInfoLike }> {
    const body = types.TaskInfoRequest.encode(types.TaskInfoRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'TaskInfo', body);
    const reply = asRecord(types.TaskInfoReply.decode(replyBody));
    return {
        task_info: reply.task_info ? normalizeTaskInfo(reply.task_info) : undefined,
    };
}

async function claimTaskReward(taskId: unknown, doShared = false): Promise<{ items: RewardLike[] }> {
    const body = types.ClaimTaskRewardRequest.encode(types.ClaimTaskRewardRequest.create({
        id: toLong(taskId),
        do_shared: doShared,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'ClaimTaskReward', body);
    const reply = asRecord(types.ClaimTaskRewardReply.decode(replyBody));
    return { items: recordArray(reply.items) };
}

async function claimDailyReward(type: unknown, pointIds: unknown[]): Promise<{ items: RewardLike[] }> {
    if (!types.ClaimDailyRewardRequest || !types.ClaimDailyRewardReply) {
        return { items: [] };
    }
    const body = types.ClaimDailyRewardRequest.encode(types.ClaimDailyRewardRequest.create({
        type: Number(type) || 0,
        point_ids: (pointIds || []).map(id => toLong(id)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'ClaimDailyReward', body);
    const reply = asRecord(types.ClaimDailyRewardReply.decode(replyBody));
    return { items: recordArray(reply.items) };
}

async function claimAllIllustratedRewards(): Promise<{ items: RewardLike[]; bonus_items: RewardLike[] }> {
    if (!types.ClaimAllRewardsV2Request || !types.ClaimAllRewardsV2Reply) {
        return { items: [], bonus_items: [] };
    }
    const body = types.ClaimAllRewardsV2Request.encode(types.ClaimAllRewardsV2Request.create({
        only_claimable: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.illustratedpb.IllustratedService', 'ClaimAllRewardsV2', body);
    const reply = asRecord(types.ClaimAllRewardsV2Reply.decode(replyBody));
    return {
        items: recordArray(reply.items),
        bonus_items: recordArray(reply.bonus_items),
    };
}

async function getTicketBalanceFromBag(): Promise<number> {
    try {
        const { getBag, getBagItems } = require('./warehouse');
        const rep = await getBag();
        const items = getBagItems(rep);
        for (const it of (items || [])) {
            if (toNum(it && it.id) === 1002) return Math.max(0, toNum(it && it.count));
        }
        return 0;
    } catch {
        return 0;
    }
}

// ============ 任务分析 ============

function formatTask(t: RawTask, category: TaskCategory = 'main'): FormattedTask {
    return {
        id: toNum(t.id),
        desc: t.desc || `任务#${toNum(t.id)}`,
        category,
        progress: toNum(t.progress),
        totalProgress: toNum(t.total_progress),
        isClaimed: t.is_claimed === true,
        isUnlocked: t.is_unlocked === true,
        shareMultiple: toNum(t.share_multiple),
        rewards: (t.rewards || []).map(r => ({ id: toNum(r.id), count: toNum(r.count) })),
        canClaim: t.is_unlocked === true
            && t.is_claimed !== true
            && toNum(t.progress) >= toNum(t.total_progress)
            && toNum(t.total_progress) > 0,
    };
}

/**
 * 分析任务列表，找出可领取的任务
 */
function analyzeTaskList(tasks: RawTask[], category: TaskCategory = 'main'): FormattedTask[] {
    const claimable: FormattedTask[] = [];
    for (const task of tasks) {
        const t = formatTask(task, category);
        if (t.canClaim) {
            claimable.push(t);
        }
    }
    return claimable;
}

/**
 * 计算奖励摘要
 */
function getRewardSummary(items: RewardLike[]): string {
    const summary: string[] = [];
    for (const item of items) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (id === 1 || id === 1001) summary.push(`金币${count}`);
        else if (id === 2 || id === 1101) summary.push(`经验${count}`);
        else if (id === 1002) summary.push(`点券${count}`);
        else summary.push(`物品#${id}x${count}`);
    }
    return summary.join('/');
}

function buildDailyTasksForDebug(taskInfo: TaskInfoLike): RawTask[] {
    const ti = taskInfo;
    const dailyList = ti.daily_tasks;
    if (dailyList.length > 0) return dailyList;
    const merged = [
        ...ti.tasks,
        ...ti.growth_tasks,
    ];
    return merged.filter((t) => toNum(t && t.task_type) === 2);
}

async function checkAndClaimActives(actives: ActiveLike[]) {
    const list = Array.isArray(actives) ? actives : [];
    let scanned = 0;
    let claimed = 0;
    let errors = 0;
    for (const active of list) {
        const activeType = toNum(active.type);
        const rewards = active.rewards || [];
        const claimable = rewards.filter(r => toNum(r.status) === 2);
        if (!claimable.length) continue;
        scanned += claimable.length;
        const pointIds = claimable.map(r => toNum(r.point_id)).filter(n => n > 0);
        if (!pointIds.length) continue;
        const typeName = activeType === 1 ? '日活跃' : (activeType === 2 ? '周活跃' : `活跃${activeType}`);
        try {
            log('活跃', `${typeName} 发现 ${pointIds.length} 个可领取奖励`, {
                module: 'task', event: '扫描活跃奖励', result: 'ok', activeType, count: pointIds.length
            });
            const reply = await claimDailyReward(activeType, pointIds);
            const items = reply.items || [];
            if (items.length > 0) {
                log('活跃', `${typeName} 领取: ${getRewardSummary(items)}`, {
                    module: 'task', event: '领取活跃奖励', result: 'ok', activeType, count: items.length
                });
            }
            claimed += pointIds.length;
            await sleep(300);
        } catch (e) {
            errors += 1;
            log('活跃', `${typeName} 领取失败: ${errorMessage(e)}`, {
                module: 'task', event: '领取活跃奖励', result: 'error', activeType
            });
        }
    }
    return { scanned, claimed, errors };
}

async function checkAndClaimIllustratedRewards(): Promise<boolean> {
    try {
        const beforeTicket = await getTicketBalanceFromBag();
        const reply = await claimAllIllustratedRewards();
        const items = [
            ...(Array.isArray(reply && reply.items) ? reply.items : []),
            ...(Array.isArray(reply && reply.bonus_items) ? reply.bonus_items : []),
        ];
        const afterTicket = await getTicketBalanceFromBag();
        const gainTicket = Math.max(0, afterTicket - beforeTicket);
        if (gainTicket < 200) return false;

        log('任务', `领取成功: 点券${gainTicket}`, {
            module: 'task',
            event: '图鉴奖励',
            result: 'ok',
            scope: 'illustrated',
            count: items.length,
        });
        taskClaimDoneDateKey = getDateKey();
        taskClaimLastAt = Date.now();
        recordOperation('taskClaim', 1);
        return true;
    } catch {
        return false;
    }
}

// ============ 自动领取 ============

async function checkAndClaimTasks(): Promise<void> {
    if (checking) return;
    if (!isAutomationOn('task')) return;
    checking = true;
    try {
        const reply = await getTaskInfo();
            if (!reply.task_info) return;

        const taskInfo = reply.task_info;
        const dailyAll = buildDailyTasksForDebug(taskInfo);

        const dailyClaimable = analyzeTaskList(dailyAll, 'daily');
        const growthClaimable = analyzeTaskList(taskInfo.growth_tasks || [], 'growth');
        const mainClaimable = analyzeTaskList(taskInfo.tasks || [], 'main');
        const claimable = [...dailyClaimable, ...growthClaimable, ...mainClaimable];
        if (claimable.length > 0) {
            log('任务', `发现 ${claimable.length} 个可领取任务`, {
                module: 'task', event: '扫描任务', result: 'ok', count: claimable.length
            });
            if (dailyClaimable.length > 0) {
                log('任务', `每日任务可领取: ${dailyClaimable.map(t => t.desc).join('，')}`, {
                    module: 'task', event: '扫描任务', result: 'ok', count: dailyClaimable.length, scope: 'daily'
                });
            }
            let dailyClaimSuccess = 0;
            for (const task of claimable) {
                const ok = await doClaim(task);
                if (task.category === 'daily' && ok) dailyClaimSuccess += 1;
            }
            if (dailyClaimable.length > 0 && dailyClaimSuccess === 0) {
                log('任务', '每日任务本次未领取成功', {
                    module: 'task', event: '领取任务', result: 'none', scope: 'daily'
                });
            }
        }
        await checkAndClaimActives(taskInfo.actives || []);
        await checkAndClaimIllustratedRewards();
    } catch (e) {
        logWarn('任务', `检查任务失败: ${errorMessage(e)}`, {
            module: 'task', event: '扫描任务', result: 'error'
        });
    } finally {
        checking = false;
    }
}

async function doClaim(task: FormattedTask): Promise<boolean> {
    try {
        const useShare = task.shareMultiple > 1;
        const multipleStr = useShare ? ` (${task.shareMultiple}倍)` : '';

        const claimReply = await claimTaskReward(task.id, useShare);
        const items = claimReply.items || [];
        const rewardStr = items.length > 0 ? getRewardSummary(items) : '无';

        const categoryName = task.category === 'daily' ? '每日任务' : (task.category === 'growth' ? '成长任务' : '任务');
        log('任务', `领取(${categoryName}): ${task.desc}${multipleStr} → ${rewardStr}`, {
            module: 'task', event: '领取任务', result: 'ok', taskId: task.id, shared: useShare
        });
        taskClaimDoneDateKey = getDateKey();
        taskClaimLastAt = Date.now();
        recordOperation('taskClaim', 1);
        await sleep(300);
        return true;
    } catch {
        // 领取失败静默处理
        return false;
    }
}

function onTaskInfoNotify(taskInfoValue: unknown): void {
    if (!taskInfoValue) return;
    const taskInfo = normalizeTaskInfo(taskInfoValue);
    if (!isAutomationOn('task')) return;

    const claimable = [
        ...analyzeTaskList(taskInfo.daily_tasks || [], 'daily'),
        ...analyzeTaskList(taskInfo.growth_tasks || [], 'growth'),
        ...analyzeTaskList(taskInfo.tasks || [], 'main'),
    ];
    const actives = taskInfo.actives || [];
    const hasClaimable = claimable.length > 0;
    if (!hasClaimable && actives.length === 0) return;
    if (hasClaimable) log('任务', `有 ${claimable.length} 个任务可领取，准备自动领取...`, {
        module: 'task', event: '领取任务', result: 'plan', count: claimable.length
    });
    taskScheduler.setTimeoutTask('task_claim_debounce', 1000, async () => {
        if (hasClaimable) await claimTasksFromList(claimable);
        await checkAndClaimActives(actives);
        await checkAndClaimIllustratedRewards();
    });
}

async function claimTasksFromList(claimable: FormattedTask[]): Promise<void> {
    if (!isAutomationOn('task')) return;
    for (const task of claimable) {
        await doClaim(task);
    }
}

// ============ 初始化 ============

function initTaskSystem(): void {
    cleanupTaskSystem();
    networkEvents.on('taskInfoNotify', onTaskInfoNotify);
    taskScheduler.setTimeoutTask('task_init_bootstrap', 4000, () => {
        checkAndClaimTasks();
    });
}

function cleanupTaskSystem(): void {
    networkEvents.off('taskInfoNotify', onTaskInfoNotify);
    taskScheduler.clearAll();
    checking = false;
}

function getTaskClaimDailyState() {
    return {
        key: 'task_claim',
        doneToday: taskClaimDoneDateKey === getDateKey(),
        lastClaimAt: taskClaimLastAt,
    };
}

async function getTaskDailyStateLikeApp() {
    try {
        const reply = await getTaskInfo();
        const ti = reply.task_info || normalizeTaskInfo({});
        const dailyAll = buildDailyTasksForDebug(ti);
        const completedDaily = dailyAll.filter((t) => {
            const progress = toNum(t.progress);
            const totalProgress = toNum(t.total_progress);
            return totalProgress > 0 && progress >= totalProgress;
        });
        const completedCount = Math.min(3, completedDaily.length);
        const pendingDaily = dailyAll.filter((t) => {
            const isUnlocked = t.is_unlocked === true;
            const isClaimed = t.is_claimed === true;
            const totalProgress = toNum(t.total_progress);
            return isUnlocked && !isClaimed && totalProgress > 0;
        });
        const dailyClaimable = analyzeTaskList(dailyAll, 'daily');
        return {
            key: 'task_claim',
            // 每日任务总数按 3 计算，完成口径为 progress >= total_progress
            doneToday: completedCount >= 3,
            lastClaimAt: taskClaimLastAt,
            claimableCount: dailyClaimable.length,
            pendingCount: pendingDaily.length,
            completedCount,
            totalCount: 3,
        };
    } catch {
        return {
            key: 'task_claim',
            doneToday: false,
            lastClaimAt: taskClaimLastAt,
            claimableCount: 0,
            pendingCount: 0,
            completedCount: 0,
            totalCount: 3,
        };
    }
}

async function getGrowthTaskStateLikeApp() {
    try {
        const reply = await getTaskInfo();
        const ti = reply.task_info || normalizeTaskInfo({});
        const tasks = ti.growth_tasks.map((t) => {
            const progress = Math.max(0, toNum(t.progress));
            const totalProgress = Math.max(0, toNum(t.total_progress));
            const isClaimed = t.is_claimed === true;
            const isUnlocked = t.is_unlocked === true;
            const isCompleted = totalProgress > 0 && progress >= totalProgress;
            return {
                id: toNum(t.id),
                desc: t.desc || `成长任务#${toNum(t.id)}`,
                progress,
                totalProgress,
                isClaimed,
                isUnlocked,
                isCompleted,
            };
        });
        const totalCount = tasks.length;
        const completedCount = tasks.filter((t) => t.isCompleted).length;
        return {
            key: 'growth_task',
            doneToday: totalCount > 0 && completedCount >= totalCount,
            completedCount,
            totalCount,
            tasks,
        };
    } catch {
        return {
            key: 'growth_task',
            doneToday: false,
            completedCount: 0,
            totalCount: 0,
            tasks: [],
        };
    }
}

export {
    checkAndClaimTasks,
    claimTaskReward,
    cleanupTaskSystem,
    doClaim, // 供手动领取使用
    getGrowthTaskStateLikeApp,
    getTaskClaimDailyState,
    getTaskDailyStateLikeApp,
    initTaskSystem,
};
