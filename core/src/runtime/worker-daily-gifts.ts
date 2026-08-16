const { getAutomation } = require('../models/store');
const { getEmailDailyState } = require('../services/email');
const { getFreeGiftDailyState } = require('../services/mall');
const { getMonthCardDailyState } = require('../services/monthcard');
const { getVipDailyState } = require('../services/qqvip');
const { getShareDailyState } = require('../services/share');
const {
    getGrowthTaskStateLikeApp,
    getTaskClaimDailyState,
    getTaskDailyStateLikeApp,
} = require('../services/task');

type DynamicRecord = Record<string, any>;

interface DailyGiftOverviewInput {
    auto: DynamicRecord;
    date?: string;
    email: DynamicRecord;
    free: DynamicRecord;
    growthTask: DynamicRecord;
    month: DynamicRecord;
    share: DynamicRecord;
    task: DynamicRecord;
    vip: DynamicRecord;
}

export function buildDailyGiftOverview(input: DailyGiftOverviewInput): DynamicRecord {
    const {
        auto,
        date = new Date().toISOString().slice(0, 10),
        email,
        free,
        growthTask,
        month,
        share,
        task,
        vip,
    } = input;

    return {
        date,
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

export async function getDailyGiftOverview(): Promise<DynamicRecord> {
    const auto = getAutomation() || {};
    const task = getTaskDailyStateLikeApp
        ? await getTaskDailyStateLikeApp()
        : (getTaskClaimDailyState ? getTaskClaimDailyState() : { doneToday: false, lastClaimAt: 0 });
    const growthTask = getGrowthTaskStateLikeApp
        ? await getGrowthTaskStateLikeApp()
        : { doneToday: false, completedCount: 0, totalCount: 0, tasks: [] };

    return buildDailyGiftOverview({
        auto,
        task,
        growthTask,
        email: getEmailDailyState ? getEmailDailyState() : { doneToday: false, lastCheckAt: 0 },
        free: getFreeGiftDailyState ? getFreeGiftDailyState() : { doneToday: false, lastClaimAt: 0 },
        share: getShareDailyState ? getShareDailyState() : { doneToday: false, lastClaimAt: 0 },
        vip: getVipDailyState ? getVipDailyState() : { doneToday: false, lastClaimAt: 0 },
        month: getMonthCardDailyState ? getMonthCardDailyState() : { doneToday: false, lastClaimAt: 0 },
    });
}
