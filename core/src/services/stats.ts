import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { getDataDir } from '../config/runtime-paths';
import { asRecord, getLocalDateKey } from './service-boundaries';

interface OperationCounts {
    harvest: number;
    water: number;
    weed: number;
    bug: number;
    fertilize: number;
    plant: number;
    steal: number;
    helpWater: number;
    helpWeed: number;
    helpBug: number;
    taskClaim: number;
    sell: number;
    upgrade: number;
    levelUp: number;
}

interface PersistedStats {
    date: string;
    operations: Partial<OperationCounts>;
    initialState?: Partial<NullableStatsState>;
    savedAt?: number;
}

interface NullableStatsState {
    gold: number | null;
    exp: number | null;
    coupon: number | null;
}

interface SessionStats {
    goldGained: number;
    expGained: number;
    couponGained: number;
    lastExpGain: number;
    lastGoldGain: number;
    lastExpTime?: number;
}

function getStatsFilePath(accountId: unknown): string {
    const dataDir = process.env.FARM_DATA_DIR || getDataDir();
    return path.join(dataDir, 'stats', `${accountId}.json`);
}

function getTodayKey(): string {
    return getLocalDateKey();
}

function loadPersistedStats(accountId: unknown): PersistedStats | null {
    try {
        const filePath = getStatsFilePath(accountId);
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw || !raw.trim()) return null;
        const parsed: unknown = JSON.parse(raw);
        const source = asRecord(parsed);
        if (typeof source.date !== 'string') return null;
        return {
            date: source.date,
            operations: asRecord(source.operations) as Partial<OperationCounts>,
            initialState: asRecord(source.initialState) as Partial<NullableStatsState>,
            savedAt: Number(source.savedAt) || 0,
        };
    } catch {
        return null;
    }
}

function savePersistedStats(accountId: unknown, data: PersistedStats): void {
    try {
        const filePath = getStatsFilePath(accountId);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch {
        // ignore
    }
}

const operations: OperationCounts = {
    harvest: 0,
    water: 0,
    weed: 0,
    bug: 0,
    fertilize: 0,
    plant: 0,
    steal: 0,
    helpWater: 0,
    helpWeed: 0,
    helpBug: 0,
    taskClaim: 0,
    sell: 0,
    upgrade: 0,
    levelUp: 0,
};

let currentDateKey: string | null = null;

const lastState = {
    gold: -1,
    exp: -1,
    coupon: -1,
};

const initialState: NullableStatsState = {
    gold: null,
    exp: null,
    coupon: null,
};

const session: SessionStats = {
    goldGained: 0,
    expGained: 0,
    couponGained: 0,
    lastExpGain: 0,
    lastGoldGain: 0,
};

let currentAccountId: string | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function recordOperation(type: unknown, count = 1): void {
    checkAndResetDailyStats();
    if (typeof type === 'string' && Object.hasOwn(operations, type)) {
        const operationType = type as keyof OperationCounts;
        operations[operationType] += count;
        scheduleSave();
    }
}

function checkAndResetDailyStats(): void {
    if (!currentAccountId) return;
    const todayKey = getTodayKey();
    if (currentDateKey && currentDateKey !== todayKey) {
        console.warn(`[统计] 检测到跨天，重置每日统计 (${currentDateKey} -> ${todayKey})`);
        (Object.keys(operations) as Array<keyof OperationCounts>).forEach((key) => {
            operations[key] = 0;
        });
    }
    currentDateKey = todayKey;
}

function scheduleSave(): void {
    if (!currentAccountId) return;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        doSave();
    }, 2000);
}

function doSave(): void {
    if (!currentAccountId) return;
    const todayKey = getTodayKey();
    const data = {
        date: todayKey,
        operations: { ...operations },
        initialState: { ...initialState },
        savedAt: Date.now(),
    };
    savePersistedStats(currentAccountId, data);
}

function initStats(gold: unknown, exp: unknown, coupon: unknown = 0): void {
    const g = Number.isFinite(Number(gold)) ? Number(gold) : 0;
    const e = Number.isFinite(Number(exp)) ? Number(exp) : 0;
    const c = Number.isFinite(Number(coupon)) ? Number(coupon) : 0;
    lastState.gold = g;
    lastState.exp = e;
    lastState.coupon = c;
    initialState.gold = g;
    initialState.exp = e;
    initialState.coupon = c;
}

function initStatsWithPersistence(accountId: unknown, gold: unknown, exp: unknown, coupon: unknown = 0): void {
    currentAccountId = String(accountId || '');
    const todayKey = getTodayKey();
    currentDateKey = todayKey;
    const saved = loadPersistedStats(accountId);

    if (saved && saved.date === todayKey) {
        (Object.keys(saved.operations || {}) as Array<keyof OperationCounts>).forEach((key) => {
            if (Object.hasOwn(operations, key)) {
                operations[key] = Number(saved.operations[key]) || 0;
            }
        });
        console.warn(`[统计] 已恢复今日统计数据: ${JSON.stringify(saved.operations)}`);
    } else {
        (Object.keys(operations) as Array<keyof OperationCounts>).forEach((key) => {
            operations[key] = 0;
        });
        if (saved) {
            console.warn(`[统计] 日期已变更，重置统计 (${saved.date} -> ${todayKey})`);
        }
    }

    initStats(gold, exp, coupon);
}

function updateStats(currentGold: number, currentExp: number): void {
    if (lastState.gold === -1) lastState.gold = currentGold;
    if (lastState.exp === -1) lastState.exp = currentExp;

    if (currentGold > lastState.gold) {
        const delta = currentGold - lastState.gold;
        session.lastGoldGain = delta;
    } else if (currentGold < lastState.gold) {
        session.lastGoldGain = 0;
    }
    lastState.gold = currentGold;

    if (currentExp > lastState.exp) {
        const delta = currentExp - lastState.exp;
        const now = Date.now();
        if (delta === session.lastExpGain && (now - (session.lastExpTime || 0) < 1000)) {
            // console.warn(`[系统] 忽略重复经验增量 +${delta}`);
        } else {
            session.lastExpGain = delta;
            session.lastExpTime = now;
            // console.warn(`[系统] 经验 +${delta} (总计: ${currentExp})`);
        }
    } else {
        session.lastExpGain = 0;
    }
    lastState.exp = currentExp;
}

function recordGoldExp(gold: number, exp: number): void {
    updateStats(gold, exp);
}

function setInitialValues(gold: unknown, exp: unknown, coupon: unknown = 0): void {
    initStats(gold, exp, coupon);
}

function resetSessionGains(): void {
    session.goldGained = 0;
    session.expGained = 0;
    session.couponGained = 0;
    session.lastGoldGain = 0;
    session.lastExpGain = 0;
    session.lastExpTime = 0;
}

function recomputeSessionTotals(currentGold: number, currentExp: number, currentCoupon: number): void {
    if (initialState.gold === null || initialState.exp === null || initialState.coupon === null) {
        initialState.gold = currentGold;
        initialState.exp = currentExp;
        initialState.coupon = currentCoupon;
    }
    session.goldGained = currentGold - initialState.gold;
    session.expGained = currentExp - initialState.exp;
    session.couponGained = currentCoupon - initialState.coupon;
}

function getStats(statusData: unknown, userState: unknown, connected: boolean, limits: unknown) {
    checkAndResetDailyStats();
    const statusObj = asRecord(statusData);
    const userObj = asRecord(userState);

    const rawGold = (userObj.gold !== null && userObj.gold !== undefined) ? userObj.gold : statusObj.gold;
    const rawExp = (userObj.exp !== null && userObj.exp !== undefined) ? userObj.exp : statusObj.exp;
    const rawCoupon = (userObj.coupon !== null && userObj.coupon !== undefined) ? userObj.coupon : statusObj.coupon;
    const rawGoldBean = (userObj.goldBean !== null && userObj.goldBean !== undefined) ? userObj.goldBean : statusObj.goldBean;
    const currentGold = Number.isFinite(Number(rawGold)) ? Number(rawGold) : 0;
    const currentExp = Number.isFinite(Number(rawExp)) ? Number(rawExp) : 0;
    const currentCoupon = Number.isFinite(Number(rawCoupon)) ? Number(rawCoupon) : 0;
    const currentGoldBean = Number.isFinite(Number(rawGoldBean)) ? Number(rawGoldBean) : 0;

    if (connected) {
        updateStats(currentGold, currentExp);
        recomputeSessionTotals(currentGold, currentExp, currentCoupon);
    }

    const operationsSnapshot = { ...operations };
    return {
        connection: { connected },
        status: {
            name: userObj.name || statusObj.name,
            level: statusObj.level || userObj.level || 0,
            gold: currentGold,
            coupon: Number.isFinite(Number(userObj.coupon)) ? Number(userObj.coupon) : 0,
            goldBean: currentGoldBean,
            exp: currentExp,
            platform: statusObj.platform || userObj.platform || 'qq',
        },
        uptime: process.uptime(),
        operations: operationsSnapshot,
        sessionExpGained: session.expGained,
        sessionGoldGained: session.goldGained,
        sessionCouponGained: session.couponGained,
        lastExpGain: session.lastExpGain,
        lastGoldGain: session.lastGoldGain,
        limits,
    };
}

function saveStats(): void {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    doSave();
}

export {
    checkAndResetDailyStats,
    getStats,
    getTodayKey,
    initStats,
    initStatsWithPersistence,
    loadPersistedStats,
    recordGoldExp,
    recordOperation,
    resetSessionGains,
    saveStats,
    setInitialValues,
    updateStats,
};
