import EventEmitter from 'node:events';
import type { AccountId, LogEntry, RuntimeConfigSnapshot, RuntimeStatusSnapshot, WorkerRecord } from '../types/domain';
const { createModuleLogger } = require('../services/logger');
const { getTodayKey, loadPersistedStats } = require('../services/stats');

type RuntimeRecord = Record<string, any>;

interface RuntimeStateStore {
    getAutomation: (accountId: AccountId) => unknown;
    getPlantingStrategy: (accountId: AccountId) => unknown;
    getPreferredSeed: (accountId: AccountId) => unknown;
    getIntervals: (accountId: AccountId) => unknown;
    getFriendQuietHours: (accountId: AccountId) => unknown;
    getAutoRelogin: (accountId: AccountId) => unknown;
    getFriendBlacklist: (accountId: AccountId) => unknown;
    getPlantBlacklist: (accountId: AccountId) => unknown;
    getKnownFriendGids: (accountId: AccountId) => unknown;
    getKnownFriendGidSyncCooldownSec: (accountId: AccountId) => unknown;
    getBagSeedPriority: (accountId: AccountId) => unknown;
    getBagSeedFallbackStrategy: (accountId: AccountId) => unknown;
}

interface RuntimeStateOptions {
    store: RuntimeStateStore;
    operationKeys?: string[];
}

interface LogFilters {
    keyword?: unknown;
    tag?: unknown;
    module?: unknown;
    event?: unknown;
    isWarn?: unknown;
    timeFrom?: unknown;
    timeTo?: unknown;
    hideDev?: unknown;
}

export interface RuntimeState {
    workers: Record<string, WorkerRecord>;
    globalLogs: LogEntry[];
    accountLogs: RuntimeRecord[];
    runtimeEvents: EventEmitter;
    nextConfigRevision: () => number;
    buildConfigSnapshotForAccount: (accountId: AccountId) => RuntimeConfigSnapshot;
    log: (tag: string, msg: string, extra?: RuntimeRecord) => void;
    addAccountLog: (action: string, msg: string, accountId?: AccountId | '', accountName?: string, extra?: RuntimeRecord) => void;
    normalizeStatusForPanel: (data: unknown, accountId: AccountId, accountName: string) => RuntimeStatusSnapshot;
    buildDefaultStatus: (accountId: AccountId) => RuntimeStatusSnapshot;
    filterLogs: (list: LogEntry[], filters?: LogFilters) => LogEntry[];
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

function formatLocalDateTime24(date: Date = new Date()): string {
    const d = date instanceof Date ? date : new Date();
    const y = d.getFullYear();
    const m = pad2(d.getMonth() + 1);
    const day = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

function createRuntimeState(options: RuntimeStateOptions): RuntimeState {
    const {
        store,
        operationKeys = [],
    } = options;

    const workers: Record<string, WorkerRecord> = {};
    const globalLogs: LogEntry[] = [];
    const accountLogs: RuntimeRecord[] = [];
    const runtimeEvents = new EventEmitter();
    let configRevision = Date.now();
    const runtimeLogger = createModuleLogger('runtime');

    function nextConfigRevision(): number {
        configRevision += 1;
        return configRevision;
    }

    function buildConfigSnapshotForAccount(accountId: AccountId): RuntimeConfigSnapshot {
        return {
            automation: store.getAutomation(accountId),
            plantingStrategy: store.getPlantingStrategy(accountId),
            preferredSeedId: store.getPreferredSeed(accountId),
            intervals: store.getIntervals(accountId),
            friendQuietHours: store.getFriendQuietHours(accountId),
            autoRelogin: store.getAutoRelogin(accountId),
            friendBlacklist: store.getFriendBlacklist(accountId),
            plantBlacklist: store.getPlantBlacklist(accountId),
            knownFriendGids: store.getKnownFriendGids(accountId),
            knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec(accountId),
            bagSeedPriority: store.getBagSeedPriority(accountId),
            bagSeedFallbackStrategy: store.getBagSeedFallbackStrategy(accountId),
            __revision: configRevision,
        };
    }

    function log(tag: string, msg: string, extra: RuntimeRecord = {}): void {
        const time = formatLocalDateTime24(new Date());
        const level = tag === '错误' ? 'error' : 'info';
        if (level === 'error') runtimeLogger.error(msg, { tag, ...extra });
        else runtimeLogger.info(msg, { tag, ...extra });
        const moduleName = (tag === '系统' || tag === '错误') ? 'system' : '';
        const entry: LogEntry = {
            time,
            tag,
            msg,
            meta: moduleName ? { module: moduleName } : {},
            ts: Date.now(),
            ...extra,
        };
        entry._searchText = `${entry.msg || ''} ${entry.tag || ''} ${JSON.stringify(entry.meta || {})}`.toLowerCase();
        globalLogs.push(entry);
        if (globalLogs.length > 1000) globalLogs.shift();
        runtimeEvents.emit('log', entry);
    }

    function addAccountLog(action: string, msg: string, accountId: AccountId | '' = '', accountName = '', extra: RuntimeRecord = {}): void {
        const entry = {
            time: formatLocalDateTime24(new Date()),
            action,
            msg,
            accountId: accountId ? String(accountId) : '',
            accountName: accountName || '',
            ...extra,
        };
        accountLogs.push(entry);
        if (accountLogs.length > 300) accountLogs.shift();
        runtimeEvents.emit('account_log', entry);
    }

    function normalizeStatusForPanel(data: unknown, accountId: AccountId, accountName: string): RuntimeStatusSnapshot {
        const src: RuntimeRecord = (data && typeof data === 'object') ? data as RuntimeRecord : {};
        const ops: Record<string, number> = (src.operations && typeof src.operations === 'object') ? { ...src.operations } : {};
        for (const k of operationKeys) {
            if (ops[k] === undefined || ops[k] === null || Number.isNaN(Number(ops[k]))) {
                ops[k] = 0;
            } else {
                ops[k] = Number(ops[k]);
            }
        }
        return {
            ...src,
            accountId,
            accountName,
            operations: ops,
        };
    }

    function buildDefaultOperations(): Record<string, number> {
        const ops: Record<string, number> = {};
        for (const k of operationKeys) ops[k] = 0;
        return ops;
    }

    function buildDefaultStatus(accountId: AccountId): RuntimeStatusSnapshot {
        const id = String(accountId || '');
        const operations = buildDefaultOperations();
        let totalSteal = 0;

        if (id) {
            const saved = loadPersistedStats(id);
            const todayKey = getTodayKey();
            if (saved) {
                if (saved.date === todayKey && saved.operations) {
                    const savedOperations = saved.operations as Record<string, unknown>;
                    for (const k of operationKeys) {
                        if (savedOperations[k] !== undefined) {
                            operations[k] = Number(savedOperations[k]) || 0;
                        }
                    }
                }
                if (typeof saved.totalSteal === 'number') {
                    totalSteal = saved.totalSteal;
                }
            }
        }

        return {
            connection: { connected: false },
            status: { name: '', level: 0, gold: 0, exp: 0, platform: 'qq' },
            uptime: 0,
            operations,
            totalSteal,
            sessionExpGained: 0,
            sessionGoldGained: 0,
            sessionCouponGained: 0,
            lastExpGain: 0,
            lastGoldGain: 0,
            limits: {},
            wsError: null,
            automation: store.getAutomation(accountId),
            preferredSeed: store.getPreferredSeed(accountId),
            expProgress: { current: 0, needed: 0, level: 0 },
            configRevision,
            accountId: id,
        };
    }

    function filterLogs(list: LogEntry[], filters: LogFilters = {}): LogEntry[] {
        const f = filters || {};
        const keyword = String(f.keyword || '').trim().toLowerCase();
        const keywordTerms = keyword ? keyword.split(/\s+/).filter(Boolean) : [];
        const tag = String(f.tag || '').trim();
        const moduleName = String(f.module || '').trim();
        const eventName = String(f.event || '').trim();
        const isWarn = f.isWarn;
        const timeFromMs = f.timeFrom ? Date.parse(String(f.timeFrom)) : Number.NaN;
        const timeToMs = f.timeTo ? Date.parse(String(f.timeTo)) : Number.NaN;
        return (list || []).filter((l: LogEntry) => {
            const logMs = Number(l && l.ts) || Date.parse(String((l && l.time) || ''));
            if (Number.isFinite(timeFromMs) && Number.isFinite(logMs) && logMs < timeFromMs) return false;
            if (Number.isFinite(timeToMs) && Number.isFinite(logMs) && logMs > timeToMs) return false;
            if (tag && String(l.tag || '') !== tag) return false;
            if (moduleName) {
                const logModule = String((l.meta || {}).module || '');
                // 兼容历史主进程日志：仅有 tag=系统/错误，没有 meta.module
                if (moduleName === 'system') {
                    const isSystemTag = String(l.tag || '') === '系统' || String(l.tag || '') === '错误';
                    if (logModule !== 'system' && !isSystemTag) return false;
                } else if (logModule !== moduleName) {
                    return false;
                }
            }
            if (eventName && String((l.meta || {}).event || '') !== eventName) return false;
            // 过滤开发模式日志（调试/探测类，meta.dev=true），默认开启
            if (f.hideDev && !!((l.meta || {}).dev)) return false;
            if (isWarn !== undefined && isWarn !== null && String(isWarn) !== '') {
                const expected = String(isWarn) === '1' || String(isWarn).toLowerCase() === 'true';
                if (!!l.isWarn !== expected) return false;
            }
            if (keywordTerms.length > 0) {
                const text = String(l._searchText || `${l.msg || ''} ${l.tag || ''}`).toLowerCase();
                for (const term of keywordTerms) {
                    if (!text.includes(term)) return false;
                }
            }
            return true;
        });
    }

    return {
        workers,
        globalLogs,
        accountLogs,
        runtimeEvents,
        nextConfigRevision,
        buildConfigSnapshotForAccount,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildDefaultStatus,
        filterLogs,
    };
}

export { createRuntimeState, formatLocalDateTime24 };
