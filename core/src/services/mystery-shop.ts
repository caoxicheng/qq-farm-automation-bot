// 神秘商人：推送驱动检测，出现后按账号自动化配置购买一次当前商品。
import { getItemDisplayById } from '../config/gameConfig';
import { sendMsgAsync } from '../utils/network';
import { types } from '../utils/proto';
import { asRecord, recordArray } from './service-boundaries';

const MYSTERY_SHOP_SERVICE = 'gamepb.mysteryshoppb.MysteryShopService';

export interface MysteryItemDto {
    id: string;
    count: string;
    name: string;
    image: string;
}

export interface MysteryShopOffer {
    key: string;
    npcId: string;
    expireTime: number;
    reward: MysteryItemDto;
    currency: {
        id: string;
        name: string;
        unitPrice: string;
        totalPrice: string;
        originalUnitPrice: string;
        originalTotalPrice: string;
    };
    discountPercent: number;
}

function int64String(value: unknown): string {
    if (value === undefined || value === null) return '0';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.trunc(value));
    return String(value);
}

function positiveInteger(value: unknown): number {
    const parsed = Number(int64String(value));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function multiplyDecimal(value: unknown, multiplier: number): string {
    const raw = int64String(value);
    if (!/^\d+$/.test(raw) || multiplier <= 0) return '0';
    return (BigInt(raw) * BigInt(multiplier)).toString();
}

function itemDto(item: unknown): MysteryItemDto {
    const source = asRecord(item);
    const id = int64String(source.id ?? source.item_id);
    const numId = Number(id) || 0;
    const display = numId > 0 ? getItemDisplayById(numId) : null;
    return {
        id,
        count: int64String(source.count ?? source.item_count),
        name: display ? String(display.name || '') : '',
        image: display ? String(display.image || '') : '',
    };
}

function currencyName(id: string): string {
    if (id === '1' || id === '1001') return '金币';
    if (id === '1002') return '点券';
    if (id === '1005') return '金豆豆';
    const display = getItemDisplayById(Number(id) || 0);
    return display?.name ? String(display.name) : `物品#${id}`;
}

export function normalizeMysteryShopOffer(value: unknown): MysteryShopOffer | null {
    const envelope = asRecord(value);
    if (envelope.is_active === false) return null;
    const npc = asRecord(envelope.npc ?? value);
    const npcId = int64String(npc.npc_id);
    const rewardItemId = int64String(npc.reward_item_id);
    const rewardCount = positiveInteger(npc.reward_count);
    const currencyId = int64String(npc.currency_item_id);
    const unitPrice = int64String(npc.unit_price);
    const originalUnitPrice = int64String(npc.original_unit_price);
    const expireTime = positiveInteger(envelope.expire_time);
    const purchasedCount = Math.max(0, Number(npc.purchased_count) || 0);
    if (!/^[1-9]\d*$/.test(npcId) || !/^[1-9]\d*$/.test(rewardItemId) || rewardCount <= 0) return null;
    if (!/^[1-9]\d*$/.test(currencyId) || !/^\d+$/.test(unitPrice) || purchasedCount > 0) return null;

    const reward = itemDto({ id: rewardItemId, count: rewardCount });
    return {
        key: `${npcId}:${expireTime || 0}`,
        npcId,
        expireTime,
        reward,
        currency: {
            id: currencyId,
            name: currencyName(currencyId),
            unitPrice,
            totalPrice: multiplyDecimal(unitPrice, rewardCount),
            originalUnitPrice,
            originalTotalPrice: multiplyDecimal(originalUnitPrice, rewardCount),
        },
        discountPercent: Math.max(0, positiveInteger(npc.discount_percent)),
    };
}

export function mysteryRewards(value: unknown): MysteryItemDto[] {
    const reply = asRecord(value);
    return recordArray(reply.rewards).map(itemDto).filter(item => item.id !== '0' && item.count !== '0');
}

export async function getActiveNPC(): Promise<unknown> {
    const body = Buffer.from(types.GetActiveNPCRequest.encode(types.GetActiveNPCRequest.create({})).finish());
    const { body: replyBody } = await sendMsgAsync(MYSTERY_SHOP_SERVICE, 'GetActiveNPC', body);
    // 历史 GetActiveNPC 使用 is_active/npc/active_time/expire_time 包装；
    // 新版推送使用 npc/expire_time。双解码兼容服务端逐步切换，避免登录补查漏掉已出现的商人。
    const notifyEnvelope = types.MysteryShopNotify.decode(replyBody);
    if (asRecord(asRecord(notifyEnvelope).npc).npc_id) return notifyEnvelope;
    return types.GetActiveNPCReply.decode(replyBody);
}

export async function buyNpcGoods(npcId: unknown): Promise<unknown> {
    const request = types.BuyRequest.create({ npc_id: npcId });
    const body = Buffer.from(types.BuyRequest.encode(request).finish());
    const { body: replyBody } = await sendMsgAsync(MYSTERY_SHOP_SERVICE, 'Buy', body);
    return types.BuyReply.decode(replyBody);
}
