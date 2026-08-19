import type { MasterToWorkerMessage, WorkerToMasterMessage } from '../types/ipc';

const { getAutomation } = require('../models/store');
const { getAvailableSeeds, getLandsDetail, runFarmOperation } = require('../services/farm');
const {
    clearFriendsListCache,
    doFriendOperation,
    getFriendLandsDetail,
    getFriendsList,
} = require('../services/friend');
const { getInteractRecords } = require('../services/interact');
const { autoBuyFertilizer, checkAndBuyFertilizerBoth } = require('../services/mall');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');

type DynamicRecord = Record<string, any>;
type ApiCallMessage = Extract<MasterToWorkerMessage, { type: 'api_call' }>;
type WorkerApiMethod = (args: any[]) => unknown | PromiseLike<unknown>;

interface WorkerApiMethodOptions {
    applyRuntimeConfig: (snapshot: DynamicRecord, syncNow?: boolean) => void;
    getDailyGiftOverview: () => unknown | PromiseLike<unknown>;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

export function createWorkerApiMethods(options: WorkerApiMethodOptions): Record<string, WorkerApiMethod> {
    const { applyRuntimeConfig, getDailyGiftOverview } = options;
    return {
        getLands: () => getLandsDetail(),
        getFriends: args => getFriendsList(args[0] === true),
        clearFriendsCache: () => {
            clearFriendsListCache();
            return { ok: true };
        },
        getInteractRecords: () => getInteractRecords(),
        getFriendLands: args => getFriendLandsDetail(args[0]),
        doFriendOp: args => doFriendOperation(args[0], args[1]),
        getSeeds: () => getAvailableSeeds(),
        getBag: () => require('../services/warehouse').getBagDetail(),
        getBagSeeds: () => require('../services/warehouse').getBagSeeds(),
        getDiamondBalance: () => require('../services/pay').getDiamondBalance(),
        useItem: (args) => {
            const { useItem } = require('../services/warehouse');
            const itemId = Number(args[0]) || 0;
            const count = Math.max(1, Number(args[1]) || 1);
            return useItem(itemId, count, [], args[2] || 0);
        },
        sellItems: (args) => {
            const { sellItems } = require('../services/warehouse');
            const sellList = Array.isArray(args[0]) ? args[0] : [];
            return sellItems(sellList.map(item => ({ id: item.id, count: item.count, uid: item.uid || 0 })));
        },
        setAutomation: (args) => {
            const payload: DynamicRecord = args?.[0] && typeof args[0] === 'object' ? args[0] : {};
            applyRuntimeConfig({ automation: { [payload.key]: payload.value } }, true);
            return getAutomation();
        },
        doFarmOp: args => runFarmOperation(args[0]),
        buyFertilizer: (args) => {
            const fertilizerType = args[0] || 'organic';
            const fertilizerCount = Number(args[1]) || 0;
            return autoBuyFertilizer(true, fertilizerType, fertilizerCount);
        },
        checkAndBuyFertilizer: args => checkAndBuyFertilizerBoth(args[0] || {}),
        getAnalytics: args => require('../services/analytics').getPlantRankings(args[0]),
        getDailyGiftOverview: () => getDailyGiftOverview(),
        getSchedulers: () => getSchedulerRegistrySnapshot(),
        // 活动中心（千星游记/观星/星砂商店/节令）
        getActivityCenterSnapshot: () => require('../services/activity').getActivityCenterSnapshot(),
        getCurrentSeasonEvent: () => require('../services/activity').getCurrentSeasonEvent(),
        getCurrentStarSandShop: () => require('../services/activity').getCurrentStarSandShop(),
        getCurrentSolarTerms: () => require('../services/activity').getCurrentSolarTerms(),
        getCurrentQingMeiActivity: () => require('../services/activity').getCurrentQingMeiActivity(),
        claimBattlePassRewards: () => require('../services/activity').claimBattlePassRewards(),
        exchangeStarSandGoods: args => require('../services/activity').exchangeStarSandGoods(args[0], args[1]),
        lightConstellation: () => require('../services/activity').lightConstellation(),
        claimSolarTerm: args => require('../services/activity').claimSolarTerm(args[0]),
        claimQingMeiDailySeed: () => require('../services/activity').claimQingMeiDailySeed(),
        startQingMeiBrew: args => require('../services/activity').startQingMeiBrew(args[0]),
        continueQingMeiBrew: () => require('../services/activity').continueQingMeiBrew(),
        settleQingMeiBrew: () => require('../services/activity').settleQingMeiBrew(),
    };
}

export function createWorkerApiHandler(
    methods: Record<string, WorkerApiMethod>,
    sendToMaster: (payload: WorkerToMasterMessage) => void,
): (message: ApiCallMessage) => Promise<void> {
    return async function handleApiCall(message: ApiCallMessage): Promise<void> {
        const { id, method, args } = message;
        let result: unknown = null;
        let error: string | undefined;

        try {
            const apiMethod = Object.hasOwn(methods, method) ? methods[method] : undefined;
            if (typeof apiMethod !== 'function') {
                error = 'Unknown method';
            } else {
                result = await apiMethod(args);
            }
        } catch (caught) {
            error = errorMessage(caught);
        }

        sendToMaster({ type: 'api_response', id, result, error });
    };
}
