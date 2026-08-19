/**
 * 分享奖励
 */

import { sendMsg, sendMsgAsync } from '../utils/network';
import { types } from '../utils/proto';
import { log } from '../utils/utils';
import {
    asRecord,
    errorMessage,
    formatRewardSummary,
    getLocalDateKey,
    recordArray,
} from './service-boundaries';

const DAILY_KEY = 'daily_share';
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;

let doneDateKey = '';
let lastCheckAt = 0;
let lastClaimAt = 0;

function markDoneToday(): void {
    doneDateKey = getLocalDateKey();
}

function isDoneToday(): boolean {
    return doneDateKey === getLocalDateKey();
}

function isAlreadyClaimedError(error: unknown): boolean {
    const msg = errorMessage(error);
    return msg.includes('code=1009001') || msg.includes('已经领取');
}

function isNoRewardError(error: unknown): boolean {
    const msg = errorMessage(error);
    return msg.includes('没有可领取') || msg.includes('暂无可领取');
}

async function checkCanShare() {
    const body = types.CheckCanShareRequest.encode(types.CheckCanShareRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'CheckCanShare', body);
    return types.CheckCanShareReply.decode(replyBody);
}

async function reportShare() {
    const body = types.ReportShareRequest.encode(types.ReportShareRequest.create({ source: 1, scene: 42 })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', body);
    return types.ReportShareReply.decode(replyBody);
}

async function reportActivityShare(source: unknown, scene: unknown): Promise<void> {
    const body = types.ReportShareRequest.encode(types.ReportShareRequest.create({ source, scene })).finish();
    const sent = await sendMsg('gamepb.sharepb.ShareService', 'ReportShare', body);
    if (!sent) throw new Error('活动分享上报发送失败');
}

async function claimShareReward() {
    const body = types.ClaimShareRewardRequest.encode(types.ClaimShareRewardRequest.create({ claimed: true })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'ClaimShareReward', body);
    return types.ClaimShareRewardReply.decode(replyBody);
}

async function claimDailyShareReward(): Promise<boolean> {
    try {
        const rep = asRecord(await claimShareReward());
        const items = recordArray(rep.items);
        const reward = formatRewardSummary(items);
        log('分享', reward ? `领取成功 → ${reward}` : '领取成功', {
            module: 'task',
            event: DAILY_KEY,
            result: 'ok',
            count: items.length,
        });
        lastClaimAt = Date.now();
        markDoneToday();
        return true;
    } catch (error) {
        const alreadyClaimed = isAlreadyClaimedError(error);
        if (!alreadyClaimed && !isNoRewardError(error)) throw error;
        markDoneToday();
        log('分享', alreadyClaimed ? '今日分享奖励已领取' : '今日暂无可领取分享礼包', {
            module: 'task',
            event: DAILY_KEY,
            result: 'none',
        });
        return false;
    }
}

async function performDailyShare(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && isDoneToday()) return false;
    if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) return false;
    lastCheckAt = now;
    try {
        const can = asRecord(await checkCanShare());
        if (!can.can_share) {
            return await claimDailyShareReward();
        }
        await reportShare();
        return await claimDailyShareReward();
    } catch (error) {
        log('分享', `领取失败: ${errorMessage(error)}`, {
            module: 'task',
            event: DAILY_KEY,
            result: 'error',
        });
        return false;
    }
}

function getShareDailyState(): {
    key: string;
    doneToday: boolean;
    lastCheckAt: number;
    lastClaimAt: number;
} {
    return {
        key: DAILY_KEY,
        doneToday: isDoneToday(),
        lastCheckAt,
        lastClaimAt,
    };
}

export {
    getShareDailyState,
    performDailyShare,
    reportActivityShare,
};
