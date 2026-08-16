import type { CoalescedBackgroundTask } from '../utils/request-coordination';
import { createCoalescedBackgroundTask } from '../utils/request-coordination';

type BattlePassNotifyListener = (pass: unknown) => void;

interface BattlePassEventBus {
    on: (event: 'battlePassNotify', listener: BattlePassNotifyListener) => unknown;
    off: (event: 'battlePassNotify', listener: BattlePassNotifyListener) => unknown;
}

interface BattlePassClaimResult {
    rewards?: unknown[];
}

interface BattlePassActivityService {
    claimBattlePassRewards: () => BattlePassClaimResult | PromiseLike<BattlePassClaimResult>;
    getBattlePassNotifyClaimability: (pass: unknown) => boolean | null;
    isNoBattlePassRewardError: (error: unknown) => boolean;
}

interface WorkerBattlePassPushOptions {
    events: BattlePassEventBus;
    activityService: BattlePassActivityService;
    isLifecycleActive: () => boolean;
    log: (tag: string, message: string, meta?: Record<string, unknown>) => void;
    delayMs?: number;
}

export interface WorkerBattlePassPushRuntime {
    start: () => void;
    stop: () => void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

export function createWorkerBattlePassPushRuntime(
    options: WorkerBattlePassPushOptions,
): WorkerBattlePassPushRuntime {
    const {
        events,
        activityService,
        isLifecycleActive,
        log,
        delayMs = 250,
    } = options;
    let listener: BattlePassNotifyListener | null = null;
    let claimTask: CoalescedBackgroundTask | null = null;

    function ensureClaimTask(): CoalescedBackgroundTask {
        if (claimTask) return claimTask;
        claimTask = createCoalescedBackgroundTask(async () => {
            if (!isLifecycleActive()) return;
            const result = await activityService.claimBattlePassRewards();
            if (!isLifecycleActive()) return;
            const rewardCount = Array.isArray(result?.rewards) ? result.rewards.length : 0;
            if (rewardCount > 0) {
                log('活动', `战令推送自动领取 ${rewardCount} 项奖励`, {
                    module: 'activity',
                    event: 'battle_pass_push_claim',
                    count: rewardCount,
                });
            }
        }, {
            delayMs,
            onError: (error: unknown) => {
                if (!isLifecycleActive() || activityService.isNoBattlePassRewardError(error)) return;
                const reason = errorMessage(error);
                log('活动', `战令推送自动领取失败: ${reason}`, {
                    module: 'activity',
                    event: 'battle_pass_push_claim_error',
                    error: reason,
                });
            },
        });
        return claimTask;
    }

    function start(): void {
        if (listener) events.off('battlePassNotify', listener);
        const task = ensureClaimTask();
        listener = (pass: unknown) => {
            if (!isLifecycleActive()) return;
            if (activityService.getBattlePassNotifyClaimability(pass) === false) return;
            task.trigger();
        };
        events.on('battlePassNotify', listener);
    }

    function stop(): void {
        if (listener) {
            events.off('battlePassNotify', listener);
            listener = null;
        }
        claimTask?.cancel();
        claimTask = null;
    }

    return { start, stop };
}
