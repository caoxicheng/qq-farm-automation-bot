import type { AccountId, AccountRecord, LogEntry, RuntimeStatusSnapshot, WorkerRecord } from '../types/domain';

const { findAccountByRef, normalizeAccountRef, resolveAccountId: resolveAccountIdByList } = require('../services/account-resolver');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');

type DynamicRecord = Record<string, any>;
export type DataProvider = Record<string, (...args: any[]) => any>;

interface StoredAccounts {
    accounts: Array<AccountRecord & { running?: boolean }>;
    [key: string]: unknown;
}

interface DataProviderOptions {
    workers: Record<string, WorkerRecord>;
    reauthRequiredStates?: Map<string, { code: number; message: string; at: number }>;
    globalLogs: LogEntry[];
    accountLogs: DynamicRecord[];
    store: Record<string, (...args: any[]) => any>;
    getAccounts: () => StoredAccounts;
    callWorkerApi: (accountId: AccountId | '', method: string, ...args: any[]) => Promise<any>;
    buildDefaultStatus: (accountId: AccountId | '') => RuntimeStatusSnapshot;
    normalizeStatusForPanel: (data: unknown, accountId: AccountId, accountName: string) => RuntimeStatusSnapshot;
    filterLogs: (list: LogEntry[], filters?: DynamicRecord) => LogEntry[];
    addAccountLog: (...args: any[]) => void;
    nextConfigRevision: () => number;
    broadcastConfigToWorkers: (accountId?: AccountId | '') => void;
    startWorker: (account: AccountRecord) => unknown;
    stopWorker: (accountId: AccountId) => unknown;
    restartWorker: (account: AccountRecord) => unknown;
    resetAutoReloginState?: (accountId: AccountId) => void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

function createDataProvider(options: DataProviderOptions): DataProvider {
    const {
        workers,
        reauthRequiredStates = new Map(),
        globalLogs,
        accountLogs,
        store,
        getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        startWorker,
        stopWorker,
        restartWorker,
        resetAutoReloginState,
    } = options;

    function getStoredAccountsList(): AccountRecord[] {
        const data = getAccounts();
        return Array.isArray(data.accounts) ? data.accounts : [];
    }

    function resolveAccountRefId(accountRef: unknown): string {
        const raw = normalizeAccountRef(accountRef);
        if (!raw) return '';
        const resolved = resolveAccountIdByList(getStoredAccountsList(), raw);
        return resolved || raw;
    }

    function findAccountByAnyRef(accountRef: unknown): AccountRecord | null {
        return findAccountByRef(getStoredAccountsList(), accountRef);
    }

    const provider: DataProvider = {
        resolveAccountId: (accountRef) => resolveAccountRefId(accountRef),

        // 获取指定账号的状态 (如果 accountId 为空，返回概览?)
        getStatus: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) return buildDefaultStatus('');
            const w = workers[accountId];
            const wsError = (w && w.wsError) || reauthRequiredStates.get(String(accountId)) || null;
            if (!w || !w.status) return { ...buildDefaultStatus(accountId), wsError };
            return {
                ...buildDefaultStatus(accountId),
                ...normalizeStatusForPanel(w.status, accountId, w.name),
                wsError,
            };
        },

        getLogs: (accountRef, optionsOrLimit) => {
            const opts = (typeof optionsOrLimit === 'object' && optionsOrLimit) ? optionsOrLimit : { limit: optionsOrLimit };
            const max = Math.max(1, Number(opts.limit) || 100);
            const rawRef = normalizeAccountRef(accountRef);
            const accountId = resolveAccountRefId(accountRef);
            // 如果没有指定账号或指定为 'all'，返回所有日志
            if (!rawRef || rawRef === 'all') {
                return filterLogs(globalLogs, opts).slice(-max);
            }
            if (!accountId) return [];
            const accId = String(accountId || '');
            return filterLogs(globalLogs.filter(l => String(l.accountId || '') === accId), opts).slice(-max);
        },

        getAccountLogs: (limit) => accountLogs.slice(-limit).reverse(),
        addAccountLog: (action, msg, accountId, accountName, extra) => addAccountLog(action, msg, accountId, accountName, extra),

        clearLogs: (accountRef) => {
            const rawRef = normalizeAccountRef(accountRef);
            const accountId = resolveAccountRefId(accountRef);
            
            if (!rawRef || rawRef === 'all') {
                globalLogs.length = 0;
                return { cleared: 'all' };
            }
            
            if (!accountId) return { cleared: 0 };
            
            const accId = String(accountId || '');
            const before = globalLogs.length;
            for (let i = globalLogs.length - 1; i >= 0; i--) {
                if (String(globalLogs[i].accountId || '') === accId) {
                    globalLogs.splice(i, 1);
                }
            }
            const after = globalLogs.length;
            return { cleared: before - after, accountId };
        },

        // 透传方法
        getLands: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getLands'),
        getFriends: (accountRef, forceSync = false) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriends', forceSync),
        clearFriendsCache: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'clearFriendsCache'),
        getInteractRecords: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getInteractRecords'),
        getFriendLands: (accountRef, gid) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriendLands', gid),
        doFriendOp: (accountRef, gid, opType) => callWorkerApi(resolveAccountRefId(accountRef), 'doFriendOp', gid, opType),
        getBag: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getBag'),
        getBagSeeds: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getBagSeeds'),
        getDiamondBalance: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getDiamondBalance'),
        useItem: (accountRef, itemId, count, uid = 0) => callWorkerApi(resolveAccountRefId(accountRef), 'useItem', itemId, count, uid),
        sellItems: (accountRef, items) => callWorkerApi(resolveAccountRefId(accountRef), 'sellItems', items),
        getDailyGifts: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getDailyGiftOverview'),
        getSeeds: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getSeeds'),

        // 活动中心（千星游记/观星/星砂商店/节令）
        getActivityCenterSnapshot: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getActivityCenterSnapshot'),
        getCurrentSeasonEvent: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentSeasonEvent'),
        getCurrentStarSandShop: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentStarSandShop'),
        getCurrentSolarTerms: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentSolarTerms'),
        getCurrentQingMeiActivity: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCurrentQingMeiActivity'),
        claimBattlePassRewards: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'claimBattlePassRewards'),
        exchangeStarSandGoods: (accountRef, goodsId, count) => callWorkerApi(resolveAccountRefId(accountRef), 'exchangeStarSandGoods', goodsId, count),
        lightConstellation: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'lightConstellation'),
        claimSolarTerm: (accountRef, termId) => callWorkerApi(resolveAccountRefId(accountRef), 'claimSolarTerm', termId),
        claimQingMeiDailySeed: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'claimQingMeiDailySeed'),
        startQingMeiBrew: (accountRef, ingredients) => callWorkerApi(resolveAccountRefId(accountRef), 'startQingMeiBrew', ingredients),
        continueQingMeiBrew: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'continueQingMeiBrew'),
        settleQingMeiBrew: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'settleQingMeiBrew'),

        setAutomation: async (accountRef, key, value) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            store.setAutomation(key, value, accountId);
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(accountId);
            return { automation: store.getAutomation(accountId), configRevision: rev };
        },

        doFarmOp: (accountRef, opType) => callWorkerApi(resolveAccountRefId(accountRef), 'doFarmOp', opType),
        doAnalytics: (accountRef, sortBy) => callWorkerApi(resolveAccountRefId(accountRef), 'getAnalytics', sortBy),
        buyFertilizer: (accountRef, type, count) => callWorkerApi(resolveAccountRefId(accountRef), 'buyFertilizer', type, count),
        checkAndBuyFertilizer: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'checkAndBuyFertilizer', options),
        saveSettings: async (accountRef, payload) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            const body = (payload && typeof payload === 'object') ? payload : {};
            const plantingStrategy = (body.plantingStrategy !== undefined) ? body.plantingStrategy : body.strategy;
            const preferredSeedId = (body.preferredSeedId !== undefined) ? body.preferredSeedId : body.seedId;
            const snapshot = {
                plantingStrategy,
                preferredSeedId,
                intervals: body.intervals,
                friendQuietHours: body.friendQuietHours,
                autoRelogin: body.autoRelogin,
                stealDelaySeconds: body.stealDelaySeconds,
                plantOrderRandom: body.plantOrderRandom,
                plantDelaySeconds: body.plantDelaySeconds,
                fertilizerBuyOrganicCount: body.fertilizerBuyOrganicCount,
                fertilizerBuyOrganicThresholdHours: body.fertilizerBuyOrganicThresholdHours,
                fertilizerBuyNormalCount: body.fertilizerBuyNormalCount,
                fertilizerBuyNormalThresholdHours: body.fertilizerBuyNormalThresholdHours,
                fertilizerBuyCheckIntervalMinutes: body.fertilizerBuyCheckIntervalMinutes,
                bagSeedPriority: body.bagSeedPriority,
                bagSeedFallbackStrategy: body.bagSeedFallbackStrategy,
            };
            store.applyConfigSnapshot(snapshot, { accountId });
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(accountId);
            return {
                strategy: store.getPlantingStrategy(accountId),
                preferredSeed: store.getPreferredSeed(accountId),
                intervals: store.getIntervals(accountId),
                friendQuietHours: store.getFriendQuietHours(accountId),
                autoRelogin: store.getAutoRelogin(accountId),
                stealDelaySeconds: store.getStealDelaySeconds(accountId),
                plantOrderRandom: store.getPlantOrderRandom(accountId),
                plantDelaySeconds: store.getPlantDelaySeconds(accountId),
                fertilizerBuyOrganicCount: store.getFertilizerBuyOrganicCount(accountId),
                fertilizerBuyOrganicThresholdHours: store.getFertilizerBuyOrganicThresholdHours(accountId),
                fertilizerBuyNormalCount: store.getFertilizerBuyNormalCount(accountId),
                fertilizerBuyNormalThresholdHours: store.getFertilizerBuyNormalThresholdHours(accountId),
                fertilizerBuyCheckIntervalMinutes: store.getFertilizerBuyCheckIntervalMinutes(accountId),
                bagSeedPriority: store.getBagSeedPriority(accountId),
                bagSeedFallbackStrategy: store.getBagSeedFallbackStrategy(accountId),
                configRevision: rev,
            };
        },

        setUITheme: async (theme) => {
            const snapshot = store.setUITheme(theme);
            return { ui: snapshot.ui || store.getUI() };
        },

        broadcastConfig: (accountId) => {
            broadcastConfigToWorkers(accountId);
        },

        setRuntimeAccountName: (accountRef, accountName) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) return;
            const worker = workers[accountId];
            if (worker) {
                worker.name = String(accountName || worker.name || accountId);
            }
        },

        // 账号管理直接操作 store
        getAccounts: () => {
            const data = getAccounts();
            data.accounts.forEach((a) => {
                const worker = workers[a.id];
                a.running = !!worker;
                if (worker && worker.status && worker.status.status && worker.status.status.name) {
                    a.nick = worker.status.status.name;
                }
            });
            return data;
        },

        startAccount: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            // 手动启动：重置自动重登状态（计数、禁用标记）
            if (typeof resetAutoReloginState === 'function' && accountId) resetAutoReloginState(accountId);
            startWorker(acc);
            return true;
        },

        stopAccount: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            if (accountId) stopWorker(accountId);
            return true;
        },

        restartAccount: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            // 手动重启：重置自动重登状态
            if (typeof resetAutoReloginState === 'function' && accountId) resetAutoReloginState(accountId);
            restartWorker(acc);
            return true;
        },

        isAccountRunning: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            return !!(accountId && workers[accountId]);
        },

        getSchedulerStatus: async (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            const runtime = getSchedulerRegistrySnapshot();
            let worker = null;
            let workerError = '';

            if (!accountId) {
                return { accountId: '', runtime, worker, workerError };
            }

            if (!workers[accountId]) {
                return { accountId, runtime, worker, workerError: '账号未运行' };
            }

            try {
                worker = await callWorkerApi(accountId, 'getSchedulers');
            } catch (e) {
                workerError = errorMessage(e);
            }
            return { accountId, runtime, worker, workerError };
        },
    };
    return provider;
}

export { createDataProvider };
