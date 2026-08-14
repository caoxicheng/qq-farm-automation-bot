/**
 * 月卡礼包
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

const DAILY_KEY = 'month_card_gift';
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;

let doneDateKey = '';
let lastCheckAt = 0;
let lastClaimAt = 0;
let lastResult = '';
let lastHasCard: boolean | null = null;
let lastHasClaimable: boolean | null = null;

function markDoneToday(): void {
    doneDateKey = getLocalDateKey();
}

function isDoneToday(): boolean {
    return doneDateKey === getLocalDateKey();
}

async function getMonthCardInfos() {
    const body = types.GetMonthCardInfosRequest.encode(types.GetMonthCardInfosRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.mallpb.MallService', 'GetMonthCardInfos', body);
    return types.GetMonthCardInfosReply.decode(replyBody);
}

async function claimMonthCardReward(goodsId: unknown) {
    const body = types.ClaimMonthCardRewardRequest.encode(types.ClaimMonthCardRewardRequest.create({
        goods_id: Number(goodsId) || 0,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.mallpb.MallService', 'ClaimMonthCardReward', body);
    return types.ClaimMonthCardRewardReply.decode(replyBody);
}

async function performDailyMonthCardGift(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && isDoneToday()) return false;
    if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) return false;
    lastCheckAt = now;

    try {
        const rep = asRecord(await getMonthCardInfos());
        const infos = recordArray(rep.infos);
        lastHasCard = infos.length > 0;
        const claimable = infos.filter((x) => x && x.can_claim && Number(x.goods_id || 0) > 0);
        lastHasClaimable = claimable.length > 0;
        if (!infos.length) {
            markDoneToday();
            lastResult = 'none';
            log('月卡', '当前没有月卡或已过期', {
                module: 'task',
                event: DAILY_KEY,
                result: 'none',
            });
            return false;
        }
        if (!claimable.length) {
            markDoneToday();
            lastResult = 'none';
            log('月卡', '今日暂无可领取月卡礼包', {
                module: 'task',
                event: DAILY_KEY,
                result: 'none',
            });
            return false;
        }
        let claimed = 0;
        for (const info of claimable) {
            try {
                const ret = asRecord(await claimMonthCardReward(Number(info.goods_id || 0)));
                const items = recordArray(ret.items);
                const reward = formatRewardSummary(items);
                log('月卡', reward ? `领取成功 → ${reward}` : '领取成功', {
                    module: 'task',
                    event: DAILY_KEY,
                    result: 'ok',
                    goodsId: Number(info.goods_id || 0),
                });
                claimed += 1;
            } catch (error) {
                log('月卡', `领取失败(gid=${Number(info.goods_id || 0)}): ${errorMessage(error)}`, {
                    module: 'task',
                    event: DAILY_KEY,
                    result: 'error',
                    goodsId: Number(info.goods_id || 0),
                });
            }
        }
        if (claimed > 0) {
            lastClaimAt = Date.now();
            markDoneToday();
            lastResult = 'ok';
            return true;
        }
        log('月卡', '本次未成功领取月卡礼包', {
            module: 'task',
            event: DAILY_KEY,
            result: 'none',
        });
        lastResult = 'none';
        return false;
    } catch (error) {
        lastResult = 'error';
        log('月卡', `查询月卡礼包失败: ${errorMessage(error)}`, {
            module: 'task',
            event: DAILY_KEY,
            result: 'error',
        });
        return false;
    }
}

function getMonthCardDailyState() {
    return {
        key: DAILY_KEY,
        doneToday: isDoneToday(),
        lastCheckAt,
        lastClaimAt,
        result: lastResult,
        hasCard: lastHasCard,
        hasClaimable: lastHasClaimable,
    };
}

export {
    getMonthCardDailyState,
    performDailyMonthCardGift,
};
