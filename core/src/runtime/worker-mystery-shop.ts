import type EventEmitter from 'node:events';
import type { MysteryShopOffer } from '../services/mystery-shop';

type DynamicRecord = Record<string, any>;
type MysteryShopOutcome = 'purchased' | 'disabled' | 'inactive' | 'expired' | 'duplicate' | 'stopped' | 'failed';

interface MysteryShopService {
    buyNpcGoods: (npcId: unknown) => unknown | PromiseLike<unknown>;
    getActiveNPC: () => unknown | PromiseLike<unknown>;
    mysteryRewards: (value: unknown) => Array<{ id: string; count: string; name: string }>;
    normalizeMysteryShopOffer: (value: unknown) => MysteryShopOffer | null;
}

interface WorkerMysteryShopRuntimeOptions {
    events: EventEmitter;
    getAutomation: () => DynamicRecord;
    isLifecycleActive: () => boolean;
    log: (tag: string, message: string, meta?: DynamicRecord) => void;
    now?: () => number;
    service: MysteryShopService;
}

export interface WorkerMysteryShopRuntime {
    checkNow: () => Promise<{ outcome: MysteryShopOutcome; offer?: MysteryShopOffer }>;
    handleOffer: (value: unknown, source?: string) => Promise<{ outcome: MysteryShopOutcome; offer?: MysteryShopOffer }>;
    start: () => void;
    stop: () => void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

export function createWorkerMysteryShopRuntime(
    options: WorkerMysteryShopRuntimeOptions,
): WorkerMysteryShopRuntime {
    const {
        events,
        getAutomation,
        isLifecycleActive,
        log,
        now = Date.now,
        service,
    } = options;
    let started = false;
    let lastPurchasedKey = '';
    let pending: null | {
        key: string;
        promise: Promise<{ outcome: MysteryShopOutcome; offer?: MysteryShopOffer }>;
    } = null;

    async function handleOffer(
        value: unknown,
        source = 'push',
    ): Promise<{ outcome: MysteryShopOutcome; offer?: MysteryShopOffer }> {
        if (!isLifecycleActive()) return { outcome: 'stopped' };
        if (!getAutomation()?.mystery_shop_buy) return { outcome: 'disabled' };
        const offer = service.normalizeMysteryShopOffer(value);
        if (!offer) return { outcome: 'inactive' };
        if (offer.expireTime > 0 && offer.expireTime * 1000 <= now()) return { outcome: 'expired', offer };
        if (lastPurchasedKey === offer.key) return { outcome: 'duplicate', offer };
        if (pending?.key === offer.key) return pending.promise;

        const promise = (async (): Promise<{ outcome: MysteryShopOutcome; offer?: MysteryShopOffer }> => {
            try {
                const reply = await service.buyNpcGoods(offer.npcId);
                if (!isLifecycleActive()) return { outcome: 'stopped', offer };
                lastPurchasedKey = offer.key;
                const rewards = service.mysteryRewards(reply);
                const rewardSummary = rewards.length > 0
                    ? rewards.map(item => `${item.name || `物品#${item.id}`}x${item.count}`).join('、')
                    : `${offer.reward.name || `物品#${offer.reward.id}`}x${offer.reward.count}`;
                log('神秘商人', `自动购买成功: ${rewardSummary}，花费${offer.currency.name}${offer.currency.totalPrice}`, {
                    module: 'mystery-shop',
                    event: 'auto_buy',
                    result: 'ok',
                    source,
                    npcId: offer.npcId,
                    rewardItemId: offer.reward.id,
                    rewardCount: offer.reward.count,
                    currencyId: offer.currency.id,
                    totalPrice: offer.currency.totalPrice,
                });
                return { outcome: 'purchased', offer };
            } catch (error) {
                const reason = errorMessage(error);
                if (isLifecycleActive()) {
                    log('神秘商人', `自动购买失败: ${reason}`, {
                        module: 'mystery-shop',
                        event: 'auto_buy',
                        result: 'error',
                        source,
                        npcId: offer.npcId,
                        error: reason,
                    });
                }
                return { outcome: 'failed', offer };
            }
        })();
        pending = { key: offer.key, promise };
        try {
            return await promise;
        } finally {
            if (pending?.promise === promise) pending = null;
        }
    }

    async function checkNow(): Promise<{ outcome: MysteryShopOutcome; offer?: MysteryShopOffer }> {
        if (!isLifecycleActive()) return { outcome: 'stopped' };
        if (!getAutomation()?.mystery_shop_buy) return { outcome: 'disabled' };
        try {
            return await handleOffer(await service.getActiveNPC(), 'active-query');
        } catch (error) {
            const reason = errorMessage(error);
            if (isLifecycleActive()) {
                log('神秘商人', `查询当前商人失败: ${reason}`, {
                    module: 'mystery-shop',
                    event: 'active_query',
                    result: 'error',
                    error: reason,
                });
            }
            return { outcome: 'failed' };
        }
    }

    const onNotify = (value: unknown): void => {
        void handleOffer(value, 'push');
    };

    function start(): void {
        if (started) return;
        started = true;
        events.on('mysteryShopNotify', onNotify);
    }

    function stop(): void {
        if (!started) return;
        started = false;
        events.off('mysteryShopNotify', onNotify);
        pending = null;
    }

    return { checkNow, handleOffer, start, stop };
}
