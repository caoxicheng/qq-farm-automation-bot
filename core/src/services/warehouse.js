/**
 * 仓库系统 - 自动出售果实
 * 协议说明：BagReply 使用 item_bag（ItemBag），item_bag.items 才是背包物品列表
 */

const { getFruitName, getPlantByFruitId, getPlantBySeedId, getItemById, getItemDisplayById, getItemSalePolicyById, getItemImageById, getSeedImageBySeedId } = require('../config/gameConfig');
const { isAutomationOn } = require('../models/store');
const { sendMsgAsync, networkEvents, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, sleep } = require('../utils/utils');
const { updateStatusGold } = require('./status');

// 已提示缺图的物品（避免重复刷日志）
const missingImageNotified = new Set();

const SELL_BATCH_SIZE = 15;
// 种子物品 ID 段（2xxxx）：活动种子不在本地 Plant.json 时也按种子处理
const SEED_ID_MIN = 20000;
const SEED_ID_MAX = 30000;
function isLikelySeedId(id) {
    const n = Number(id) || 0;
    return n >= SEED_ID_MIN && n < SEED_ID_MAX;
}
// 果实物品 ID 段（4xxxx）：活动种子对应果实不在本地 Plant.json 时也按果实处理
const FRUIT_ID_MIN = 40000;
const FRUIT_ID_MAX = 50000;
function isLikelyFruitId(id) {
    const n = Number(id) || 0;
    return n >= FRUIT_ID_MIN && n < FRUIT_ID_MAX;
}
const FERTILIZER_RELATED_IDS = new Set([
    100003, // 化肥礼包
    100004, // 有机化肥礼包
    80001, 80002, 80003, 80004, // 普通化肥道具
    80011, 80012, 80013, 80014, // 有机化肥道具
]);
const FERTILIZER_CONTAINER_LIMIT_HOURS = 990;
const NORMAL_CONTAINER_ID = 1011;
const ORGANIC_CONTAINER_ID = 1012;
const NORMAL_FERTILIZER_ITEM_HOURS = new Map([
    [80001, 1], [80002, 4], [80003, 8], [80004, 12],
]);
const ORGANIC_FERTILIZER_ITEM_HOURS = new Map([
    [80011, 1], [80012, 4], [80013, 8], [80014, 12],
]);
let fertilizerGiftDoneDateKey = '';
let fertilizerGiftLastOpenAt = 0;

function getDateKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ============ API ============

async function getBag(timeoutOrOptions = 20000) {
    const body = types.BagRequest.encode(types.BagRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Bag', body, timeoutOrOptions);
    return types.BagReply.decode(replyBody);
}

function toSellItem(item) {
    const idNum = toNum(item && item.id);
    const countNum = toNum(item && item.count);
    const uidNum = toNum(item && item.uid);
    const payload = {
        id: toLong(idNum),
        count: toLong(countNum),
    };
    // SellRequest 通常只需要 id + count；仅在 uid 有效时携带
    if (uidNum > 0) payload.uid = toLong(uidNum);
    return payload;
}

function getSellEligibility(itemOrId) {
    const id = toNum(typeof itemOrId === 'object' ? itemOrId && itemOrId.id : itemOrId);
    const policy = getItemSalePolicyById(id);
    const rewards = (policy && Array.isArray(policy.rewards) ? policy.rewards : []).map((reward) => ({
        id: Number(reward.id) || 0,
        amount: Number(reward.amount) || 0,
        unit: getRewardUnit(reward.id),
    }));
    const primary = rewards[0] || null;
    return {
        sellable: policy?.status === 'available',
        status: policy?.status || 'unavailable',
        itemType: Number(policy?.itemType) || 0,
        rewards,
        condition: policy?.condition || null,
        priceId: primary?.id || 0,
        price: primary?.amount || 0,
    };
}

function getRewardUnit(rewardId) {
    const id = Number(rewardId) || 0;
    if (id === 1 || id === 1001) return '金币';
    if (id === 1002) return '点券';
    if (id === 1005) return '金豆豆';
    const display = getItemDisplayById(id);
    return display?.name && display.name !== `物品 #${id}` ? display.name : `物品 #${id}`;
}

function isAutoSellEligible(eligibility) {
    return eligibility?.sellable === true
        && eligibility.itemType === 6
        && Array.isArray(eligibility.rewards)
        && eligibility.rewards.length > 0
        && eligibility.rewards.every((reward) => reward.id === 1 || reward.id === 1001);
}

async function sellItems(items) {
    // 服务器限制单次 Sell 请求 items 数量（>19 报错）——分批卖出。
    // SELL_BATCH_SIZE=15 为自动卖果实实测安全值；面板批量卖出（一次全发）也走这里分批。
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return null;
    for (const item of list) {
        const id = toNum(item && item.id);
        const count = toNum(item && item.count);
        if (id <= 0 || count <= 0) throw new Error('出售物品参数无效');
        if (!getSellEligibility(id).sellable) throw new Error(`物品 ${id} 当前不可直接出售`);
    }
    let lastReply = null;
    for (let i = 0; i < list.length; i += SELL_BATCH_SIZE) {
        const batch = list.slice(i, i + SELL_BATCH_SIZE);
        const payload = batch.map(toSellItem);
        const body = types.SellRequest.encode(types.SellRequest.create({ items: payload })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Sell', body);
        lastReply = types.SellReply.decode(replyBody);
    }
    return lastReply;
}

async function useItem(itemId, count = 1, landIds = []) {
    const body = types.UseRequest.encode(types.UseRequest.create({
        item: { id: toLong(itemId), count: toLong(count) },
    })).finish();
    try {
        const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', body);
        return types.UseReply.decode(replyBody);
    } catch (e) {
        const msg = String((e && e.message) || '');
        const isParamError = msg.includes('code=1000020') || msg.includes('请求参数错误');
        if (!isParamError) throw e;

        // 兼容旧服务端平铺编码，待协议稳定后移除。
        const fallbackType = require('protobufjs').Type.fromJSON('LegacyUseRequest', {
            fields: {
                item_id: { type: 'int64', id: 1 },
                count: { type: 'int64', id: 2 },
                land_ids: { rule: 'repeated', type: 'int64', id: 3 },
            },
        });
        const fallbackBody = fallbackType.encode(fallbackType.create({
            item_id: toLong(itemId),
            count: toLong(count),
            land_ids: (landIds || []).map((id) => toLong(id)),
        })).finish();

        const { body: fallbackReplyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', fallbackBody);
        return types.UseReply.decode(fallbackReplyBody);
    }
}

async function batchUseItems(items) {
    const payload = (items || []).map((it) => ({
        id: toLong(it.itemId),
        count: toLong(it.count || 1),
        uid: toLong(it.uid || 0),
    }));
    const body = types.BatchUseRequest.encode(types.BatchUseRequest.create({ items: payload })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'BatchUse', body);
    return types.BatchUseReply.decode(replyBody);
}

function getBagItems(bagReply) {
    if (bagReply && bagReply.item_bag && bagReply.item_bag.items && bagReply.item_bag.items.length) {
        return bagReply.item_bag.items;
    }
    return bagReply && bagReply.items ? bagReply.items : [];
}

function isFertilizerRelatedItemId(itemId) {
    const id = Number(itemId) || 0;
    if (id <= 0) return false;
    // 禁止对容器道具执行使用，避免触发 1011/1012 补充逻辑
    if (id === 1011 || id === 1012) return false;
    if (FERTILIZER_RELATED_IDS.has(id)) return true;
    const info = getItemById(id);
    if (!info || typeof info !== 'object') return false;
    const interactionType = String(info.interaction_type || '').toLowerCase();
    return interactionType === 'fertilizer' || interactionType === 'fertilizerpro';
}

function collectFertilizerUsePayload(items) {
    const merged = new Map();
    for (const it of (items || [])) {
        const id = toNum(it && it.id);
        const count = Math.max(0, toNum(it && it.count));
        if (id <= 0 || count <= 0) continue;
        if (!isFertilizerRelatedItemId(id)) continue;
        merged.set(id, (merged.get(id) || 0) + count);
    }
    return Array.from(merged.entries()).map(([id, count]) => ({ id, count }));
}

function getContainerHoursFromBagItems(items) {
    let normalSec = 0;
    let organicSec = 0;
    for (const it of (items || [])) {
        const id = toNum(it && it.id);
        const count = Math.max(0, toNum(it && it.count));
        if (id === NORMAL_CONTAINER_ID) normalSec = count;
        if (id === ORGANIC_CONTAINER_ID) organicSec = count;
    }
    return {
        normal: normalSec / 3600,
        organic: organicSec / 3600,
    };
}

function getFertilizerItemTypeAndHours(itemId) {
    const id = Number(itemId) || 0;
    if (NORMAL_FERTILIZER_ITEM_HOURS.has(id)) {
        return { type: 'normal', perItemHours: NORMAL_FERTILIZER_ITEM_HOURS.get(id) };
    }
    if (ORGANIC_FERTILIZER_ITEM_HOURS.has(id)) {
        return { type: 'organic', perItemHours: ORGANIC_FERTILIZER_ITEM_HOURS.get(id) };
    }
    const info = getItemById(id) || {};
    const interactionType = String(info.interaction_type || '').toLowerCase();
    if (interactionType === 'fertilizer') return { type: 'normal', perItemHours: 1 };
    if (interactionType === 'fertilizerpro') return { type: 'organic', perItemHours: 1 };
    return { type: 'other', perItemHours: 0 };
}

function isFertilizerContainerFullError(err) {
    const msg = String((err && err.message) || '');
    return msg.includes('code=1003002')
        || msg.includes('普通化肥容器已达到上限')
        || msg.includes('普通化肥容器已满')
        || msg.includes('有机化肥容器已达到上限')
        || msg.includes('有机化肥容器已满');
}

async function autoOpenFertilizerGiftPacks() {
    try {
        const bagReply = await getBag();
        const bagItems = getBagItems(bagReply);
        const payloads = collectFertilizerUsePayload(bagItems);
        if (payloads.length <= 0) {
            return 0;
        }
        const containerHours = getContainerHoursFromBagItems(bagItems);

        let opened = 0;
        const details = [];
        // 按条目 BatchUse，避免数量大时逐个 Use 造成请求风暴
        for (const row of payloads) {
            const itemId = Number(row.id) || 0;
            const rawCount = Math.max(1, Number(row.count) || 0);
            const { type, perItemHours } = getFertilizerItemTypeAndHours(itemId);
            let useCount = rawCount;

            // 容器达到 990h 后不再使用对应化肥道具；未达到时也按剩余可用小时裁剪数量
            if (type === 'normal' || type === 'organic') {
                const currentHours = type === 'normal' ? containerHours.normal : containerHours.organic;
                if (currentHours >= FERTILIZER_CONTAINER_LIMIT_HOURS) {
                    continue;
                }
                if (perItemHours > 0) {
                    const remainHours = Math.max(0, FERTILIZER_CONTAINER_LIMIT_HOURS - currentHours);
                    const maxCountByHours = Math.floor(remainHours / perItemHours);
                    useCount = Math.max(0, Math.min(rawCount, maxCountByHours));
                    if (useCount <= 0) continue;
                }
            }
            const itemInfo = getItemById(itemId);
            const itemName = itemInfo && itemInfo.name ? String(itemInfo.name) : `物品#${itemId}`;
            let used = 0;
            try {
                await batchUseItems([{ itemId, count: useCount, uid: 0 }]);
                used = useCount;
            } catch {
                // BatchUse 失败时直接跳过该条目
                used = 0;
            }
            if (used > 0) {
                opened += used;
                details.push(`${itemName}x${used}`);
                if (type === 'normal' && perItemHours > 0) containerHours.normal += used * perItemHours;
                if (type === 'organic' && perItemHours > 0) containerHours.organic += used * perItemHours;
            }
            await sleep(100);
        }

        if (opened > 0) {
            fertilizerGiftDoneDateKey = getDateKey();
            fertilizerGiftLastOpenAt = Date.now();
            log('仓库', `自动使用化肥类道具 x${opened}${details.length ? ` [${details.join('，')}]` : ''}`, {
                module: 'warehouse',
                event: '开启化肥礼包',
                result: 'ok',
                count: opened,
            });
        }
        return opened;
    } catch (e) {
        if (isFertilizerContainerFullError(e)) {
            return 0;
        }
        logWarn('仓库', `开启化肥礼包失败: ${e.message}`, {
            module: 'warehouse',
            event: '开启化肥礼包',
            result: 'error',
        });
        return 0;
    }
}

async function openFertilizerGiftPacksSilently() {
    return autoOpenFertilizerGiftPacks();
}

function getGoldFromItems(items) {
    for (const item of (items || [])) {
        const id = toNum(item.id);
        if (id === 1 || id === 1001) {
            const count = toNum(item.count);
            if (count > 0) return count;
        }
    }
    return 0;
}

function deriveGoldGainFromSellReply(reply, lastKnownGold) {
    const gainFromGetItems = getGoldFromItems((reply && reply.get_items) || []);
    if (gainFromGetItems > 0) {
        // get_items 通常就是本次获得值
        return { gain: gainFromGetItems, nextKnownGold: lastKnownGold };
    }

    // 兼容旧 proto/旧结构
    const currentOrDelta = getGoldFromItems((reply && (reply.items || reply.sell_items)) || []);
    if (currentOrDelta <= 0) return { gain: 0, nextKnownGold: lastKnownGold };

    // 协议在不同场景下可能返回“当前总金币”或“本次变化值”
    if (lastKnownGold > 0 && currentOrDelta >= lastKnownGold) {
        return { gain: currentOrDelta - lastKnownGold, nextKnownGold: currentOrDelta };
    }
    return { gain: currentOrDelta, nextKnownGold: lastKnownGold };
}

function getCurrentTotals() {
    const state = getUserState() || {};
    return {
        gold: Number(state.gold || 0),
        exp: Number(state.exp || 0),
    };
}

async function getCurrentTotalsFromBag() {
    const bagReply = await getBag();
    const items = getBagItems(bagReply);
    let gold = null;
    let exp = null;
    for (const item of items) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (id === 1 || id === 1001) gold = count;       // 金币
        if (id === 1101) exp = count;     // 累计经验
    }
    return { gold, exp };
}

async function getBagDetail() {
    const bagReply = await getBag();
    const rawItems = getBagItems(bagReply);
    
    // 保留原始物品列表（用于出售等操作）
    const originalItems = [];
    for (const it of (rawItems || [])) {
        const id = toNum(it.id);
        const count = toNum(it.count);
        const uid = toNum(it.uid);
        if (id <= 0 || count <= 0) continue;
        originalItems.push({ id, count, uid });
    }
    
    // 合并展示
    const merged = new Map();
    for (const it of (rawItems || [])) {
        const id = toNum(it.id);
        const count = toNum(it.count);
        if (id <= 0 || count <= 0) continue;
        const info = getItemById(id) || null;
        const display = getItemDisplayById(id);
        let name = display && display.name ? String(display.name) : (info && info.name ? String(info.name) : '');
        let category = display && display.kind && display.kind !== 'unknown' ? display.kind : 'item';
        if (id === 1 || id === 1001) {
            name = '金币';
            category = 'gold';
        } else if (id === 1101) {
            name = '经验';
            category = 'exp';
        } else if (getPlantByFruitId(id) || isLikelyFruitId(id)) {
            if (!name || name === `物品 #${id}`) {
                const fruitName = getFruitName(id);
                name = fruitName === `果实${id}` ? `果实#${id}` : `${fruitName}果实`;
            }
            category = 'fruit';
        } else if (getPlantBySeedId(id) || isLikelySeedId(id)) {
            const p = getPlantBySeedId(id);
            if (!name || name === `物品 #${id}`) name = p && p.name ? `${p.name}种子` : `种子#${id}`;
            category = 'seed';
        }
        if (!name) name = `物品 #${id}`;
        const interactionType = info && info.interaction_type ? String(info.interaction_type) : '';
        const sellEligibility = getSellEligibility(id);
        const primaryReward = sellEligibility.rewards[0] || null;
        const displayPrice = display && display.price;
        const priceId = primaryReward?.id || (info ? (Number(info.price_id) || 0) : (Number(displayPrice && displayPrice.id) || 0));
        const price = primaryReward?.amount || (info ? (Number(info.price) || 0) : (Number(displayPrice && displayPrice.amount) || 0));
        const priceUnit = primaryReward?.unit || (priceId ? getRewardUnit(priceId) : '');

        if (!merged.has(id)) {
            const image = getItemImageById(id);
            // 种子/果实段缺图时提示同步（去重，避免刷屏）
            if (!image && (isLikelySeedId(id) || isLikelyFruitId(id)) && !missingImageNotified.has(id)) {
                missingImageNotified.add(id);
                logWarn('仓库', `物品 ${id} 未包含在当前发布资源包中`, {
                    module: 'warehouse',
                    event: 'missing_image',
                    itemId: id,
                });
            }
            merged.set(id, {
                id,
                count: 0,
                name,
                image,
                category,
                itemType: display && display.itemType ? display.itemType : (category === 'seed' ? 5 : (category === 'fruit' ? 6 : (info ? (Number(info.type) || 0) : 0))),
                priceId,
                price,
                priceUnit,
                sellable: sellEligibility.sellable,
                sellStatus: sellEligibility.status,
                sellRewards: sellEligibility.rewards,
                sellCondition: sellEligibility.condition,
                level: info ? (Number(info.level) || 0) : (Number(display && display.level) || 0),
                interactionType,
                hoursText: '',
            });
        }
        const row = merged.get(id);
        row.count += count;
    }

    const items = Array.from(merged.values()).map((row) => {
        if (row.interactionType === 'fertilizerbucket' && row.count > 0) {
            // 游戏显示更接近截断到 1 位小数（非四舍五入）
            const hoursFloor1 = Math.floor((row.count / 3600) * 10) / 10;
            row.hoursText = `${hoursFloor1.toFixed(1)}小时`;
        } else {
            row.hoursText = '';
        }
        return row;
    });
    items.sort((a, b) => {
        const taRaw = Number(a.itemType || 0);
        const tbRaw = Number(b.itemType || 0);
        const typePriority = new Map([
            [17, 0],
            [5, 1],
            [6, 2],
        ]);
        const ta = typePriority.has(taRaw) ? typePriority.get(taRaw) : (taRaw > 0 ? (1000 + taRaw) : Number.MAX_SAFE_INTEGER);
        const tb = typePriority.has(tbRaw) ? typePriority.get(tbRaw) : (tbRaw > 0 ? (1000 + tbRaw) : Number.MAX_SAFE_INTEGER);
        if (ta !== tb) return ta - tb;
        const ca = Number(a.count || 0);
        const cb = Number(b.count || 0);
        if (cb !== ca) return cb - ca;
        return Number(a.id || 0) - Number(b.id || 0);
    });
    return { totalKinds: items.length, items, originalItems };
}

// ============ 出售逻辑 ============

/**
 * 检查并出售所有果实
 */
async function sellAllFruits() {
    const sellEnabled = isAutomationOn('sell');
    if (!sellEnabled) {
        return;
    }
    try {
        const bagReply = await getBag();
        const items = getBagItems(bagReply);

        const toSell = [];
        const names = [];
        for (const item of items) {
            const id = toNum(item.id);
            const count = toNum(item.count);
            const eligibility = getSellEligibility(id);
            if (isAutoSellEligible(eligibility) && count > 0) {
                toSell.push(item);
                const display = getItemDisplayById(id);
                const name = display?.name && display.name !== `物品 #${id}` ? display.name : getFruitName(id);
                names.push(`${name}x${count}`);
            }
        }

        if (toSell.length === 0) {
            log('仓库', '无果实可出售');
            return;
        }

        const totalsBefore = getCurrentTotals();
        const goldBefore = totalsBefore.gold;
        let serverGoldTotal = 0;
        let knownGold = goldBefore;
        for (let i = 0; i < toSell.length; i += SELL_BATCH_SIZE) {
            const batch = toSell.slice(i, i + SELL_BATCH_SIZE);
            try {
                const reply = await sellItems(batch);
                const inferred = deriveGoldGainFromSellReply(reply, knownGold);
                const gained = Math.max(0, toNum(inferred.gain));
                knownGold = inferred.nextKnownGold;
                if (gained > 0) serverGoldTotal += gained;
            } catch (batchErr) {
                // 某个条目可能参数非法，降级为逐个出售，跳过错误条目
                logWarn('仓库', `批量出售失败，改为逐个重试: ${batchErr.message}`);
                for (const it of batch) {
                    try {
                        const singleReply = await sellItems([it]);
                        const inferred = deriveGoldGainFromSellReply(singleReply, knownGold);
                        const gained = Math.max(0, toNum(inferred.gain));
                        knownGold = inferred.nextKnownGold;
                        if (gained > 0) serverGoldTotal += gained;
                    } catch (singleErr) {
                        const sid = toNum(it.id);
                        const sc = toNum(it.count);
                        logWarn('仓库', `跳过不可售物品: ID=${sid} x${sc} (${singleErr.message})`, {
                            module: 'warehouse',
                            event: '跳过不可售物品',
                            result: 'skip',
                            itemId: sid,
                            count: sc,
                        });
                    }
                }
            }
            if (i + SELL_BATCH_SIZE < toSell.length) await sleep(300);
        }
        // 等待金币通知更新（最多 2s）
        let goldAfter = goldBefore;
        const startWait = Date.now();
        while (Date.now() - startWait < 2000) {
            const currentGold = (getUserState() && getUserState().gold) ? getUserState().gold : goldAfter;
            if (currentGold !== goldBefore) {
                goldAfter = currentGold;
                break;
            }
            await sleep(200);
        }
        const totalsAfter = getCurrentTotals();
        const totalGoldDelta = goldAfter > goldBefore ? (goldAfter - goldBefore) : 0;
        const totalsDeltaGold = totalsAfter.gold - totalsBefore.gold;
        const totalsDeltaExp = totalsAfter.exp - totalsBefore.exp;

        // 通知缺失时，尝试从背包读取金币做最终兜底
        let bagDelta = 0;
        if (totalGoldDelta <= 0 && serverGoldTotal <= 0) {
            try {
                const bagAfter = await getBag();
                const bagGold = getGoldFromItems(getBagItems(bagAfter));
                if (bagGold > goldBefore) bagDelta = bagGold - goldBefore;
            } catch {}
        }

        const totalGoldEarned = Math.max(serverGoldTotal, totalGoldDelta, bagDelta);
        if (totalGoldDelta <= 0 && totalGoldEarned > 0) {
            // 某些情况下 ItemNotify 丢失，使用出售回包做金币兜底同步
            const state = getUserState();
            if (state) {
                state.gold = Number(state.gold || 0) + totalGoldEarned;
                updateStatusGold(state.gold);
            }
        }
        log('仓库', `出售 ${names.join(', ')}${totalGoldEarned > 0 ? `，获得 ${totalGoldEarned} 金币` : ''}`, {
            module: 'warehouse',
            event: totalGoldEarned > 0 ? 'sell_success' : 'sell_done',
            result: totalGoldEarned > 0 ? 'ok' : 'unknown_gain',
            count: toSell.length,
            gold: totalGoldEarned,
            totalsBefore,
            totalsAfter,
            totalsDeltaGold,
            totalsDeltaExp,
        });
        
        // 发送出售事件，用于统计金币收益
        if (totalGoldEarned > 0) {
            networkEvents.emit('sell', totalGoldEarned);
        }
    } catch (e) {
        logWarn('仓库', `出售失败: ${e.message}`);
    }
}

async function getBagSeeds() {
    const bagReply = await getBag();
    const rawItems = getBagItems(bagReply);
    const merged = new Map();

    for (const item of (rawItems || [])) {
        const seedId = toNum(item && item.id);
        const count = toNum(item && item.count);
        if (seedId <= 0 || count <= 0) continue;

        const plant = getPlantBySeedId(seedId);
        // 活动种子（2xxxx 段）不在本地植物配置时，兜底识别为种子：
        // 种植请求直接按 seedId 发送，服务端自行处理（含 2x2 从属地块）
        const isUnknownSeed = !plant && isLikelySeedId(seedId);
        if (!plant && !isUnknownSeed) continue;

        const current = merged.get(seedId) || {
            seedId,
            name: String((plant && plant.name) || `种子#${seedId}`),
            count: 0,
            requiredLevel: Math.max(0, Number((plant && plant.land_level_need) || 0)),
            image: getSeedImageBySeedId(seedId) || getItemImageById(seedId),
            plantSize: Math.max(1, Number((plant && plant.size) || 1)),
        };
        current.count += count;
        merged.set(seedId, current);
    }

    return Array.from(merged.values());
}

module.exports = {
    getBag,
    getBagDetail,
    sellItems,
    useItem,
    batchUseItems,
    openFertilizerGiftPacksSilently,
    getFertilizerGiftDailyState: () => ({
        key: 'fertilizer_gift_open',
        doneToday: fertilizerGiftDoneDateKey === getDateKey(),
        lastOpenAt: fertilizerGiftLastOpenAt,
    }),
    sellAllFruits,
    getBagItems,
    getCurrentTotalsFromBag,
    getBagSeeds,
    getContainerHoursFromBagItems,
    getSellEligibility,
    isAutoSellEligible,
};
