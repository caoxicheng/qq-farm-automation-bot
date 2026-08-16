import crypto from 'node:crypto';
import { getDataFile } from '../config/runtime-paths';
import { getServerTimeSec, log, logWarn, toNum } from '../utils/utils';
import { readJsonFile, writeJsonFileAtomic } from './json-db';

type DynamicRecord = Record<string, any>;

interface FriendOperationLimitTrackerOptions {
    getDateKey: () => string;
    loadBadDailyStop: (dateKey: string) => boolean;
    persistBadDailyStop: (dateKey: string) => void;
    log: (tag: string, message: string, meta?: DynamicRecord) => void;
}

export interface FriendOperationLimitTracker {
    autoDisableHelpByExpLimit: () => void;
    canGetExpByCandidates: (operationIds?: unknown[]) => boolean;
    canGetHelpExperience: () => boolean;
    canOperate: (operationId: unknown) => boolean;
    checkDailyReset: () => void;
    getOperationLimits: () => DynamicRecord;
    getRemainingBadOperationTimes: () => number;
    isBadOperationLimitReached: () => boolean;
    isHelpExpLimitReached: () => boolean;
    markBadOperationLimitReached: (method?: string) => boolean;
    resetHelpExpAvailability: () => void;
    updateOperationLimits: (limits: DynamicRecord[]) => void;
}

export const BAD_SHARED_LIMIT_ID = 10003;
const BAD_DAILY_STATE_VERSION = 1;
const OPERATION_NAMES: Record<number, string> = {
    10001: '收获',
    10002: '铲除',
    10003: '放草',
    10004: '放虫',
    10005: '除草',
    10006: '除虫',
    10007: '浇水',
    10008: '偷菜',
};

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function getBeijingDateKey(): string {
    const nowSec = getServerTimeSec();
    const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
    const date = new Date(nowMs + 8 * 3600 * 1000);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getBadDailyStateFile(): string {
    const accountId = String(process.env.FARM_ACCOUNT_ID || 'default');
    const token = crypto.createHash('sha256').update(accountId, 'utf8').digest('hex');
    return getDataFile(`friend-bad-state-${token}.json`);
}

function loadBadDailyStop(dateKey: string): boolean {
    const state = readJsonFile<DynamicRecord>(getBadDailyStateFile(), () => ({}));
    return Number(state?.version) === BAD_DAILY_STATE_VERSION
        && String(state?.date || '') === dateKey
        && state?.stopped === true;
}

function persistBadDailyStop(dateKey: string): void {
    try {
        writeJsonFileAtomic(getBadDailyStateFile(), {
            version: BAD_DAILY_STATE_VERSION,
            date: dateKey,
            stopped: true,
        });
    } catch (error) {
        logWarn('好友', `保存当日捣乱停用状态失败: ${errorMessage(error)}`);
    }
}

export function createFriendOperationLimitTracker(
    options: FriendOperationLimitTrackerOptions,
): FriendOperationLimitTracker {
    const operationLimits = new Map<number, DynamicRecord>();
    let lastResetDate = '';
    let badOperationLimitReached = false;
    let canGetHelpExp = true;
    let helpAutoDisabledByLimit = false;

    function checkDailyReset(): void {
        const today = options.getDateKey();
        if (lastResetDate === today) return;
        if (lastResetDate !== '') options.log('系统', '跨日重置，清空操作限制缓存');
        operationLimits.clear();
        canGetHelpExp = true;
        badOperationLimitReached = options.loadBadDailyStop(today);
        if (helpAutoDisabledByLimit) {
            helpAutoDisabledByLimit = false;
            options.log('好友', '新的一天已开始，自动恢复帮忙操作功能', {
                module: 'friend',
                event: '好友巡查循环',
                result: 'ok',
            });
        }
        lastResetDate = today;
    }

    function markBadOperationLimitReached(method = ''): boolean {
        checkDailyReset();
        if (badOperationLimitReached) return false;
        badOperationLimitReached = true;
        options.persistBadDailyStop(lastResetDate || options.getDateKey());
        options.log('好友', '今日放虫/放草次数已达上限，停止两类操作', {
            module: 'friend',
            event: '放虫放草次数上限',
            ...(method ? { method } : {}),
        });
        return true;
    }

    function updateOperationLimits(limits: DynamicRecord[]): void {
        if (!Array.isArray(limits) || limits.length === 0) return;
        checkDailyReset();
        for (const limit of limits) {
            const id = toNum(limit.id);
            if (id <= 0) continue;
            const data = {
                dayTimes: toNum(limit.day_times),
                dayTimesLimit: toNum(limit.day_times_lt),
                dayExpTimes: toNum(limit.day_exp_times),
                dayExpTimesLimit: toNum(limit.day_ex_times_lt),
            };
            operationLimits.set(id, data);
            if (id === BAD_SHARED_LIMIT_ID && data.dayTimesLimit > 0 && data.dayTimes >= data.dayTimesLimit) {
                markBadOperationLimitReached('operation_limit');
            }
        }
    }

    function getRemainingTimes(operationId: unknown): number {
        const limit = operationLimits.get(toNum(operationId));
        if (!limit || limit.dayTimesLimit <= 0) return 999;
        return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
    }

    return {
        autoDisableHelpByExpLimit(): void {
            if (!canGetHelpExp) return;
            canGetHelpExp = false;
            helpAutoDisabledByLimit = true;
            options.log('好友', '今日帮助经验已达上限，自动停止帮忙', {
                module: 'friend',
                event: '好友巡查循环',
                result: 'ok',
            });
        },
        canGetExpByCandidates(operationIds: unknown[] = []): boolean {
            const ids = Array.isArray(operationIds) ? operationIds : [operationIds];
            return ids.some((id) => {
                const limit = operationLimits.get(toNum(id));
                if (!limit) return false;
                return limit.dayExpTimesLimit <= 0 || limit.dayExpTimes < limit.dayExpTimesLimit;
            });
        },
        canGetHelpExperience: () => canGetHelpExp,
        canOperate(operationId: unknown): boolean {
            const limit = operationLimits.get(toNum(operationId));
            return !limit || limit.dayTimesLimit <= 0 || limit.dayTimes < limit.dayTimesLimit;
        },
        checkDailyReset,
        getOperationLimits(): DynamicRecord {
            const result: DynamicRecord = {};
            for (const id of Object.keys(OPERATION_NAMES).map(Number)) {
                const limit = operationLimits.get(id);
                if (!limit) continue;
                result[id] = {
                    name: OPERATION_NAMES[id],
                    ...limit,
                    remaining: getRemainingTimes(id),
                };
            }
            return result;
        },
        getRemainingBadOperationTimes(): number {
            checkDailyReset();
            if (badOperationLimitReached) return 0;
            return getRemainingTimes(BAD_SHARED_LIMIT_ID);
        },
        isBadOperationLimitReached(): boolean {
            checkDailyReset();
            return badOperationLimitReached;
        },
        isHelpExpLimitReached: () => helpAutoDisabledByLimit,
        markBadOperationLimitReached,
        resetHelpExpAvailability(): void {
            canGetHelpExp = true;
        },
        updateOperationLimits,
    };
}

export const friendOperationLimits = createFriendOperationLimitTracker({
    getDateKey: getBeijingDateKey,
    loadBadDailyStop,
    persistBadDailyStop,
    log,
});
