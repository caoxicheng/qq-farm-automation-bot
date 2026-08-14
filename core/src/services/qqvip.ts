/**
 * QQ 会员每日礼包
 */

import { sendMsgAsync } from '../utils/network';
import { types } from '../utils/proto';
import { log } from '../utils/utils';
import {
    asRecord,
    errorMessage,
    formatRewardSummary,
    getLocalDateKey,
    recordArray,
} from './service-boundaries';

const DAILY_KEY = 'vip_daily_gift';
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;

let doneDateKey = '';
let lastCheckAt = 0;
let lastClaimAt = 0;
let lastResult = '';
let lastHasGift: boolean | null = null;
let lastCanClaim: boolean | null = null;

function markDoneToday(): void {
    doneDateKey = getLocalDateKey();
}

function isDoneToday(): boolean {
    return doneDateKey === getLocalDateKey();
}

function isAlreadyClaimedError(error: unknown): boolean {
    const msg = errorMessage(error);
    return msg.includes('code=1021002') || msg.includes('今日已领取') || msg.includes('已领取');
}

async function getDailyGiftStatus() {
    const body = types.GetDailyGiftStatusRequest.encode(types.GetDailyGiftStatusRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.qqvippb.QQVipService', 'GetDailyGiftStatus', body);
    return types.GetDailyGiftStatusReply.decode(replyBody);
}

async function claimDailyGift() {
    const body = types.ClaimDailyGiftRequest.encode(types.ClaimDailyGiftRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.qqvippb.QQVipService', 'ClaimDailyGift', body);
    return types.ClaimDailyGiftReply.decode(replyBody);
}

async function performDailyVipGift(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && isDoneToday()) return false;
    if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) return false;
    lastCheckAt = now;

    try {
        const status = asRecord(await getDailyGiftStatus());
        lastHasGift = Boolean(status.has_gift);
        lastCanClaim = Boolean(status.can_claim);
        if (!status.can_claim) {
            markDoneToday();
            lastResult = 'none';
            log('会员', '今日暂无可领取会员礼包', {
                module: 'task',
                event: DAILY_KEY,
                result: 'none',
            });
            return false;
        }
        const rep = asRecord(await claimDailyGift());
        const items = recordArray(rep.items);
        const reward = formatRewardSummary(items);
        log('会员', reward ? `领取成功 → ${reward}` : '领取成功', {
            module: 'task',
            event: DAILY_KEY,
            result: 'ok',
            count: items.length,
        });
        lastClaimAt = Date.now();
        markDoneToday();
        lastResult = 'ok';
        return true;
    } catch (error) {
        if (isAlreadyClaimedError(error)) {
            markDoneToday();
            lastClaimAt = Date.now();
            lastResult = 'ok';
            log('会员', '今日会员礼包已领取', {
                module: 'task',
                event: DAILY_KEY,
                result: 'ok',
            });
            return false;
        }
        lastResult = 'error';
        log('会员', `领取会员礼包失败: ${errorMessage(error)}`, {
            module: 'task',
            event: DAILY_KEY,
            result: 'error',
        });
        return false;
    }
}

function getVipDailyState() {
    return {
        key: DAILY_KEY,
        doneToday: isDoneToday(),
        lastCheckAt,
        lastClaimAt,
        result: lastResult,
        hasGift: lastHasGift,
        canClaim: lastCanClaim,
    };
}

export {
    getVipDailyState,
    performDailyVipGift,
};
