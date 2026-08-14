// 神秘商人：MysteryShopService（GetActiveNPC 查询 + Buy 购买）
// 协议抓包验证：GetActiveNPC 返回限时商品（ActiveNPC），Buy 传 npc_id + count
import { getItemDisplayById } from '../config/gameConfig';
import { sendMsgAsync } from '../utils/network';
import { types } from '../utils/proto';
import { toNum } from '../utils/utils';
import { asRecord, recordArray } from './service-boundaries';
const { getBag, getBagItems } = require('./warehouse');

export interface MysteryItemDto {
    id: string;
    count: string;
    name: string;
    image: string;
}

export interface MysteryShopSnapshot {
    active: boolean;
    serverTime: number;
    activeTime?: number;
    expireTime?: number;
    npc: null | {
        id: string;
        reward: MysteryItemDto;
        stock: number;
        price: { id: string; count: string; balance: string | number | null };
        originalPrice: string;
        discountPercent: number;
    };
}

const MYSTERY_SHOP_SERVICE = 'gamepb.mysteryshoppb.MysteryShopService';

function int64String(value: unknown): string {
    if (value === undefined || value === null) return '0';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.trunc(value));
    return String(value);
}

function itemDto(item: unknown): MysteryItemDto {
    const source = asRecord(item);
    const id = int64String(source.id ?? source.item_id);
    const numId = Number(id) || 0;
    const display = numId ? getItemDisplayById(numId) : null;
    return {
        id,
        count: int64String(source.count ?? source.item_count),
        name: display ? String(display.name || '') : '',
        image: display ? String(display.image || '') : '',
    };
}

function getServerTimeSec(): number {
    return Math.floor(Date.now() / 1000);
}

async function readBagBalances(currencyIds: unknown[]): Promise<Map<string, string | number>> {
    const requested = new Set(currencyIds.map((id) => String(id)));
    const balances = new Map<string, string | number>(currencyIds.map(id => [String(id), 0]));
    try {
        const bagReply = await getBag();
        for (const item of getBagItems(bagReply)) {
            const source = asRecord(item);
            const id = int64String(source.id ?? source.item_id);
            if (!requested.has(id)) continue;
            const count = BigInt(int64String(source.count ?? source.item_count) || '0');
            balances.set(id, (BigInt(balances.get(id) || '0') + (count > 0n ? count : 0n)).toString());
        }
    } catch { /* 余额读取失败则显示未知 */ }
    return balances;
}

async function getActiveNPC() {
    const body = Buffer.from(types.GetActiveNPCRequest.encode(types.GetActiveNPCRequest.create({})).finish());
    const { body: replyBody } = await sendMsgAsync(MYSTERY_SHOP_SERVICE, 'GetActiveNPC', body);
    return types.GetActiveNPCReply.decode(replyBody);
}

async function buyNpcGoods(npcId: unknown, count = 1) {
    const req = types.BuyRequest.create({ npc_id: npcId, count });
    const body = Buffer.from(types.BuyRequest.encode(req).finish());
    const { body: replyBody } = await sendMsgAsync(MYSTERY_SHOP_SERVICE, 'Buy', body);
    return types.BuyReply.decode(replyBody);
}

// 面板 DTO：当前神秘商人状态（商品/价格/余额/限时倒计时）
async function getMysteryShopSnapshot(): Promise<MysteryShopSnapshot> {
    const reply = asRecord(await getActiveNPC());
    const npc = asRecord(reply.npc);
    if (Object.keys(npc).length === 0 || !reply.is_active) {
        return { active: false, serverTime: getServerTimeSec() * 1000, npc: null };
    }
    const currencyId = Math.max(0, toNum(npc.currency_item_id));
    const balances = await readBagBalances([currencyId]);
    const rewardItemId = Number(int64String(npc.reward_item_id)) || 0;
    const rewardDisplay = rewardItemId ? getItemDisplayById(rewardItemId) : null;
    return {
        active: true,
        serverTime: getServerTimeSec() * 1000,
        activeTime: Math.max(0, toNum(npc.active_time)) * 1000,
        expireTime: Math.max(0, toNum(npc.expire_time)) * 1000,
        npc: {
            id: int64String(npc.npc_id),
            reward: {
                id: int64String(npc.reward_item_id),
                count: int64String(npc.reward_count),
                name: rewardDisplay ? String(rewardDisplay.name || '') : '',
                image: rewardDisplay ? String(rewardDisplay.image || '') : '',
            },
            stock: Math.max(0, toNum(npc.stock_count)),
            price: {
                id: int64String(npc.currency_item_id),
                count: int64String(npc.price),
                balance: balances.get(String(currencyId)) ?? null,
            },
            originalPrice: int64String(npc.original_price),
            discountPercent: Math.max(0, toNum(npc.discount_percent)),
        },
    };
}

// 购买：返回购买结果 + 最新快照
async function buyMysteryGoods(npcId: unknown, count = 1): Promise<{
    rewards: MysteryItemDto[];
    snapshot: MysteryShopSnapshot;
}> {
    const reply = asRecord(await buyNpcGoods(npcId, count));
    const rewards = recordArray(reply.rewards).map(item => itemDto(item));
    const snapshot = await getMysteryShopSnapshot();
    return { rewards, snapshot };
}

export {
    buyMysteryGoods,
    buyNpcGoods,
    getActiveNPC,
    getMysteryShopSnapshot,
};
