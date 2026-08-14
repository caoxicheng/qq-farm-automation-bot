/** 青酿换万金活动协议与 DTO。 */

const { sendMsgAsync, GatewayError } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum } = require('../utils/utils');
const { getItemDisplayById } = require('../config/gameConfig');
const { getBag, getBagItems } = require('./warehouse');
const { reportActivityShare } = require('./share');

const DAILY_ACTIVITY_ID = 2026081201;
const BREW_ACTIVITY_ID = 2026081202;
const QINGMEI_ITEM_ID = 41221;
const DAILY_GRANT_ID = 3;
const OPERATE_QUERY = 7;
const OPERATE_CLAIM_SEED = 4;
const OPERATE_START = 14;
const OPERATE_CONTINUE = 15;
const OPERATE_SETTLE = 16;
const SHARED_SETTLEMENT_MODE = 2;
const ALREADY_CLAIMED_CODE = 1034014;
let claimedDateKey = '';
const knownQuotes = new Map();

function int64String(value) {
    if (value == null) return '0';
    if (typeof value === 'string') return /^-?\d+$/.test(value) ? value : '0';
    if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : '0';
    if (typeof value.toString === 'function') {
        const text = value.toString();
        return /^-?\d+$/.test(text) ? text : '0';
    }
    return '0';
}

function positiveBigInt(value) {
    const text = int64String(value);
    return /^[1-9]\d*$/.test(text) ? BigInt(text) : null;
}

function quoteTotalMatches(totalGold, unitPrice, baseGold, basePrice) {
    const total = positiveBigInt(totalGold);
    const unit = positiveBigInt(unitPrice);
    const baseTotal = positiveBigInt(baseGold);
    const baseUnit = positiveBigInt(basePrice);
    if (total === null || unit === null || baseTotal === null || baseUnit === null) return false;
    return baseTotal * unit / baseUnit === total;
}

function deriveUnitPrice(totalGold, baseGold, basePrice) {
    const total = positiveBigInt(totalGold);
    const baseTotal = positiveBigInt(baseGold);
    const baseUnit = positiveBigInt(basePrice);
    if (total === null || baseTotal === null || baseUnit === null) return '0';
    const numerator = total * baseUnit;
    if (numerator % baseTotal !== 0n) return '0';
    return (numerator / baseTotal).toString();
}

function normalizeQuote(quote) {
    if (!quote) return null;
    const round = toNum(quote.round);
    const unitPrice = int64String(quote.unit_price ?? quote.unitPrice);
    const totalGold = int64String(quote.total_gold ?? quote.totalGold);
    if (round <= 0 || unitPrice === '0' || totalGold === '0') return null;
    return { round, unitPrice, totalGold, doubled: !!quote.doubled };
}

function rememberQuote(quote) {
    const normalized = normalizeQuote(quote);
    if (normalized) knownQuotes.set(normalized.round, normalized);
    return normalized;
}

function buildQuoteHistory(brew, directQuote = null) {
    const totals = (Array.isArray(brew && brew.quote_totals) ? brew.quote_totals : []).map(int64String);
    const rawPrices = (Array.isArray(brew && brew.quote_prices) ? brew.quote_prices : []).map(int64String);
    const baseGold = int64String(brew && brew.base_gold);
    const basePrice = int64String(brew && brew.base_price);
    const currentRound = Math.max(0, toNum(brew && brew.current_round));
    const exactQuote = rememberQuote(directQuote);
    if (currentRound === 0 && totals.length === 0) knownQuotes.clear();
    for (const round of [...knownQuotes.keys()]) {
        if (currentRound > 0 && round > currentRound) knownQuotes.delete(round);
    }

    return totals.map((totalGold, index) => {
        const round = index + 1;
        const captured = exactQuote && exactQuote.round === round ? exactQuote : knownQuotes.get(round);
        if (captured && captured.totalGold === totalGold) return captured;
        const rawUnitPrice = rawPrices[index] || '0';
        const unitPrice = quoteTotalMatches(totalGold, rawUnitPrice, baseGold, basePrice)
            ? rawUnitPrice
            : deriveUnitPrice(totalGold, baseGold, basePrice);
        return { round, unitPrice, totalGold, doubled: false };
    });
}

function positiveInt64(value, fieldName) {
    const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : String(value || '').trim();
    if (!/^[1-9]\d*$/.test(text) || text.length > 19 || BigInt(text) > 9223372036854775807n) {
        const error = new Error(`${fieldName} 必须是 int64 范围内的正整数`);
        error.code = `INVALID_QINGMEI_${fieldName.toUpperCase()}`;
        throw error;
    }
    return text;
}

function beijingDateKey() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function itemDto(item) {
    const id = toNum(item && (item.item_id ?? item.id));
    const display = id > 0 ? getItemDisplayById(id) : null;
    return { id: String(id || 0), count: int64String(item && item.count), name: display && display.name || '', image: display && display.image || '' };
}

function ingredientsFromBag(bagReply) {
    return getBagItems(bagReply)
        .filter((item) => toNum(item && item.id) === QINGMEI_ITEM_ID && toNum(item && item.uid) > 0 && toNum(item && item.count) > 0)
        .map((item) => ({
            ...itemDto(item),
            uid: int64String(item.uid),
            mutantTypes: (Array.isArray(item.mutant_types) ? item.mutant_types : []).map(int64String),
        }));
}

async function operate(requestType, payload, timeoutOrOptions = 20000) {
    const body = requestType.encode(requestType.create(payload)).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body, timeoutOrOptions);
    return types.ActivityOperateReply.decode(replyBody);
}

async function queryReply(timeoutOrOptions = 20000) {
    return operate(types.QueryActivityRequest, { activity_id: toLong(BREW_ACTIVITY_ID), operate_type: OPERATE_QUERY }, timeoutOrOptions);
}

function normalize(reply, ingredients = null) {
    const activity = reply && reply.data && reply.data.activity;
    const brew = reply && reply.data && reply.data.qingmei_brew || {};
    const dailySeed = reply && reply.data && reply.data.qingmei_daily_seed;
    const quote = reply && (reply.qingmei_quote || reply.data && reply.data.qingmei_quote);
    const quotes = buildQuoteHistory(brew, quote);
    const normalizedQuote = normalizeQuote(quote);
    const currentRound = toNum(brew.current_round);
    const maxRounds = Math.max(1, toNum(brew.max_rounds) || 3);
    const started = toNum(brew.base_gold) > 0;
    const claimed = claimedDateKey === beijingDateKey() || !!(dailySeed && dailySeed.claimed);
    const balanceKnown = Array.isArray(ingredients);
    const availableIngredients = balanceKnown ? ingredients : [];
    const balance = availableIngredients.reduce((sum, item) => sum + BigInt(item.count), 0n).toString();
    return {
        activityId: int64String(activity && activity.activity_id) !== '0' ? int64String(activity.activity_id) : String(BREW_ACTIVITY_ID),
        name: activity && activity.name || '青酿换万金',
        startTime: int64String(activity && activity.begin_time),
        endTime: int64String(activity && activity.end_time),
        ingredient: itemDto({ id: QINGMEI_ITEM_ID, count: balance }),
        ingredients: availableIngredients,
        balance,
        balanceKnown,
        baseGold: int64String(brew.base_gold),
        basePrice: int64String(brew.base_price),
        guaranteedPrice: int64String(brew.guaranteed_price),
        currentRound,
        maxRounds,
        started,
        finished: !!brew.finished,
        quotes,
        quotePrices: quotes.map((entry) => entry.unitPrice),
        quoteTotals: quotes.map((entry) => entry.totalGold),
        quote: normalizedQuote,
        dailySeed: { claimed, grantId: int64String(dailySeed && dailySeed.grant && dailySeed.grant.grant_id) || String(DAILY_GRANT_ID) },
        actions: {
            claimSeed: { enabled: !claimed, available: !claimed },
            start: { enabled: !started && balanceKnown && availableIngredients.length > 0, available: !started && balanceKnown && availableIngredients.length > 0 },
            continue: { enabled: started && !brew.finished && currentRound < maxRounds, available: started && !brew.finished && currentRound < maxRounds },
            settle: { enabled: started && (quotes.length > 0 || !!brew.finished), available: started && (quotes.length > 0 || !!brew.finished) },
        },
    };
}

async function getCurrentQingMeiActivity(bagInput = null, timeoutOrOptions = 20000) {
    const bagPromise = bagInput && typeof bagInput.then === 'function'
        ? bagInput
        : Promise.resolve(bagInput || getBag());
    const [replyResult, bagResult] = await Promise.allSettled([queryReply(timeoutOrOptions), bagPromise]);
    if (replyResult.status === 'rejected') throw replyResult.reason;
    const ingredients = bagResult.status === 'fulfilled' ? ingredientsFromBag(bagResult.value) : null;
    return normalize(replyResult.value, ingredients);
}

async function claimDailySeed() {
    try {
        const reply = await operate(types.ClaimQingMeiDailySeedRequest, {
            activity_id: toLong(DAILY_ACTIVITY_ID), operate_type: OPERATE_CLAIM_SEED, params: { grant_id: toLong(DAILY_GRANT_ID) },
        });
        claimedDateKey = beijingDateKey();
        return { rewards: (Array.isArray(reply.rewards) ? reply.rewards : []).map(itemDto), message: '青梅种子领取成功' };
    } catch (error) {
        if (!(error instanceof GatewayError) || error.code !== ALREADY_CLAIMED_CODE) throw error;
        claimedDateKey = beijingDateKey();
        return { rewards: [], message: '今日青梅种子已经领取' };
    }
}

async function startBrew(input) {
    if (!Array.isArray(input) || input.length === 0) throw new Error('至少选择一组青梅');
    const available = ingredientsFromBag(await getBag());
    const byUid = new Map(available.map((item) => [item.uid, BigInt(item.count)]));
    const seen = new Set();
    const ingredients = input.map((item) => {
        const uid = positiveInt64(item && item.uid, 'uid');
        const count = positiveInt64(item && item.count, 'count');
        if (seen.has(uid)) throw new Error(`青梅 UID ${uid} 重复`);
        seen.add(uid);
        if (!byUid.has(uid) || byUid.get(uid) < BigInt(count)) throw new Error(`青梅 UID ${uid} 数量不足`);
        return { uid: toLong(uid), count: toLong(count) };
    });
    await operate(types.StartQingMeiBrewRequest, { activity_id: toLong(BREW_ACTIVITY_ID), operate_type: OPERATE_START, params: { ingredients } });
    knownQuotes.clear();
    return { message: `已投入 ${ingredients.reduce((sum, item) => sum + toNum(item.count), 0)} 个青梅` };
}

async function continueBrew() {
    const reply = await operate(types.ContinueQingMeiBrewRequest, { activity_id: toLong(BREW_ACTIVITY_ID), operate_type: OPERATE_CONTINUE, params: {} });
    const quote = reply.qingmei_quote || reply.data && reply.data.qingmei_quote;
    const normalizedQuote = rememberQuote(quote);
    return { message: normalizedQuote ? `第 ${normalizedQuote.round} 轮报价：${normalizedQuote.totalGold} 金币` : '酿造进度已更新' };
}

async function settleBrew() {
    await reportActivityShare(11, 215);
    const reply = await operate(types.SettleQingMeiBrewRequest, {
        activity_id: toLong(BREW_ACTIVITY_ID), operate_type: OPERATE_SETTLE, params: { settlement_mode: SHARED_SETTLEMENT_MODE },
    });
    const settlement = reply.qingmei_settlement;
    knownQuotes.clear();
    return {
        rewards: settlement && settlement.reward ? [itemDto(settlement.reward)] : (Array.isArray(reply.rewards) ? reply.rewards : []).map(itemDto),
        message: settlement ? `分享出售成功，获得 ${int64String(settlement.total_gold)} 金币` : '青梅已按分享奖励结算',
    };
}

module.exports = { getCurrentQingMeiActivity, claimDailySeed, startBrew, continueBrew, settleBrew, ingredientsFromBag, buildQuoteHistory };
