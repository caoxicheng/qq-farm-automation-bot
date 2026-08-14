/**
 * 邮箱系统 - 自动领取邮箱奖励
 */

import { sendMsgAsync } from '../utils/network';
import { types } from '../utils/proto';
import { log } from '../utils/utils';
import {
    asRecord,
    errorMessage,
    formatRewardSummary,
    getLocalDateKey,
    recordArray
    
} from './service-boundaries';
import type {UnknownRecord} from './service-boundaries';

interface EmailRecord extends UnknownRecord {
    __boxType?: number;
}

const DAILY_KEY = 'email_rewards';
let doneDateKey = '';
let lastCheckAt = 0;
const CHECK_COOLDOWN_MS = 5 * 60 * 1000;

function markDoneToday(): void {
    doneDateKey = getLocalDateKey();
}

function isDoneToday(): boolean {
    return doneDateKey === getLocalDateKey();
}

async function getEmailList(boxType: unknown = 1) {
    const body = types.GetEmailListRequest.encode(types.GetEmailListRequest.create({
        box_type: Number(boxType) || 1,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.emailpb.EmailService', 'GetEmailList', body);
    return types.GetEmailListReply.decode(replyBody);
}

async function claimEmail(boxType: unknown = 1, emailId: unknown = '') {
    const body = types.ClaimEmailRequest.encode(types.ClaimEmailRequest.create({
        box_type: Number(boxType) || 1,
        email_id: String(emailId || ''),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.emailpb.EmailService', 'ClaimEmail', body);
    return types.ClaimEmailReply.decode(replyBody);
}

async function batchClaimEmail(boxType: unknown = 1, emailId: unknown = '') {
    const body = types.BatchClaimEmailRequest.encode(types.BatchClaimEmailRequest.create({
        box_type: Number(boxType) || 1,
        email_id: String(emailId || ''),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.emailpb.EmailService', 'BatchClaimEmail', body);
    return types.BatchClaimEmailReply.decode(replyBody);
}

function collectClaimableEmails(reply: unknown): EmailRecord[] {
    const emails = recordArray(asRecord(reply).emails);
    return emails.filter(email => Boolean(email.id && email.has_reward === true && email.claimed !== true));
}

function normalizeBoxType(value: unknown): 1 | 2 {
    const n = Number(value);
    return (n === 1 || n === 2) ? n : 1;
}

async function checkAndClaimEmails(force = false): Promise<{ claimed: number; rewardItems: number }> {
    const now = Date.now();
    if (!force && isDoneToday()) return { claimed: 0, rewardItems: 0 };
    if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) return { claimed: 0, rewardItems: 0 };
    lastCheckAt = now;

    try {
        const [box1, box2] = await Promise.all([
            getEmailList(1).catch(() => ({ emails: [] })),
            getEmailList(2).catch(() => ({ emails: [] })),
        ]);

        const merged = new Map<unknown, EmailRecord>();
        const fromBox1 = recordArray(asRecord(box1).emails)
            .map((email): EmailRecord => ({ ...email, __boxType: 1 }));
        const fromBox2 = recordArray(asRecord(box2).emails)
            .map((email): EmailRecord => ({ ...email, __boxType: 2 }));
        for (const email of [...fromBox1, ...fromBox2]) {
            if (!email.id) continue;
            // 优先保留“有奖励且未领取”的版本
            if (!merged.has(email.id)) {
                merged.set(email.id, email);
                continue;
            }
            const old = merged.get(email.id);
            const oldClaimable = !!(old && old.has_reward === true && old.claimed !== true);
            const nowClaimable = email.has_reward === true && email.claimed !== true;
            if (!oldClaimable && nowClaimable) merged.set(email.id, email);
        }

        const claimable = collectClaimableEmails({ emails: [...merged.values()] });
        if (claimable.length === 0) {
            markDoneToday();
            log('邮箱', '今日暂无可领取邮箱奖励', {
                module: 'task',
                event: DAILY_KEY,
                result: 'none',
            });
            return { claimed: 0, rewardItems: 0 };
        }

        const rewards: UnknownRecord[] = [];
        let claimed = 0;

        // 先按邮箱类型尝试批量领取，失败则继续单领
        const byBox = new Map<1 | 2, EmailRecord[]>();
        for (const email of claimable) {
            const boxType = normalizeBoxType(email.__boxType);
            if (!byBox.has(boxType)) byBox.set(boxType, []);
            byBox.get(boxType)?.push(email);
        }
        for (const [boxType, list] of byBox.entries()) {
            try {
                const firstId = String((list[0] && list[0].id) || '');
                if (firstId) {
                    const br = asRecord(await batchClaimEmail(boxType, firstId));
                    const items = recordArray(br.items);
                    if (items.length > 0) {
                        rewards.push(...items);
                    }
                    claimed += 1;
                }
            } catch {
                // 批量失败静默，继续单领
            }
        }

        for (const email of claimable) {
            const boxType = normalizeBoxType(email.__boxType);
            try {
                const rep = asRecord(await claimEmail(boxType, String(email.id || '')));
                const items = recordArray(rep.items);
                if (items.length > 0) {
                    rewards.push(...items);
                }
                claimed += 1;
            } catch {
                // 单封失败静默
            }
        }

        if (claimed > 0) {
            const rewardStr = formatRewardSummary(rewards);
            log('邮箱', rewardStr ? `[邮箱领取] 领取成功 ${claimed} 封 → ${rewardStr}` : `[邮箱领取] 领取成功 ${claimed} 封`, {
                module: 'task',
                event: DAILY_KEY,
                result: 'ok',
                count: claimed,
            });
            markDoneToday();
        }

        return { claimed, rewardItems: rewards.length };
    } catch (error) {
        log('邮箱', `领取邮箱奖励失败: ${errorMessage(error)}`, {
            module: 'task',
            event: DAILY_KEY,
            result: 'error',
        });
        return { claimed: 0, rewardItems: 0 };
    }
}

function getEmailDailyState(): { key: string; doneToday: boolean; lastCheckAt: number } {
    return {
        key: DAILY_KEY,
        doneToday: isDoneToday(),
        lastCheckAt,
    };
}

export {
    batchClaimEmail,
    checkAndClaimEmails,
    claimEmail,
    getEmailDailyState,
    getEmailList,
};
