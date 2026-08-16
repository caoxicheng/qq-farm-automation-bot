import type { Scheduler } from '../services/scheduler';

type DynamicRecord = Record<string, any>;

interface WorkerAutomationSchedulerOptions {
    checkAndClaimEmails: () => unknown | PromiseLike<unknown>;
    checkAndClaimTasks: () => unknown | PromiseLike<unknown>;
    checkFarm: () => unknown | PromiseLike<unknown>;
    checkFriends: (options: DynamicRecord) => unknown | PromiseLike<unknown>;
    config: DynamicRecord;
    getAutomation: () => DynamicRecord;
    isHelpExpLimitReached: () => boolean;
    isLoginReady: () => boolean;
    log: (tag: string, message: string, meta?: DynamicRecord) => void;
    now?: () => number;
    openFertilizerGiftPacksSilently: () => unknown | PromiseLike<unknown>;
    random?: () => number;
    scheduler: Scheduler;
}

export interface WorkerAutomationScheduler {
    getScheduleTimes: () => { farm: number; help: number; steal: number };
    reset: () => void;
    scheduleNext: () => void;
    start: () => void;
    stop: () => void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

export function randomIntervalMs(
    minMs: unknown,
    maxMs: unknown,
    random: () => number = Math.random,
): number {
    const minSec = Math.max(1, Math.floor(Math.max(1000, Number(minMs) || 1000) / 1000));
    const maxSec = Math.max(minSec, Math.floor(Math.max(1000, Number(maxMs) || minSec * 1000) / 1000));
    if (maxSec === minSec) return minSec * 1000;
    const sec = minSec + Math.floor(random() * (maxSec - minSec + 1));
    return sec * 1000;
}

export function createWorkerAutomationScheduler(
    options: WorkerAutomationSchedulerOptions,
): WorkerAutomationScheduler {
    const {
        checkAndClaimEmails,
        checkAndClaimTasks,
        checkFarm,
        checkFriends,
        config,
        getAutomation,
        isHelpExpLimitReached,
        isLoginReady,
        log,
        now = Date.now,
        openFertilizerGiftPacksSilently,
        random = Math.random,
        scheduler,
    } = options;
    let running = false;
    let farmTaskRunning = false;
    let helpTaskRunning = false;
    let stealTaskRunning = false;
    let nextFarmRunAt = 0;
    let nextHelpRunAt = 0;
    let nextStealRunAt = 0;

    function getFarmInterval(): number {
        return randomIntervalMs(
            config.farmCheckIntervalMin || config.farmCheckInterval || 2000,
            config.farmCheckIntervalMax || config.farmCheckInterval || 2000,
            random,
        );
    }

    function getHelpInterval(): number {
        return randomIntervalMs(
            config.helpCheckIntervalMin || 10000,
            config.helpCheckIntervalMax || 10000,
            random,
        );
    }

    function getStealInterval(): number {
        return randomIntervalMs(
            config.stealCheckIntervalMin || 10000,
            config.stealCheckIntervalMax || 10000,
            random,
        );
    }

    function reset(): void {
        const farmInterval = getFarmInterval();
        const helpInterval = getHelpInterval();
        const stealInterval = getStealInterval();
        const currentTime = now();
        nextFarmRunAt = currentTime + farmInterval;
        nextHelpRunAt = currentTime + helpInterval;
        nextStealRunAt = currentTime + stealInterval;
    }

    async function runFarmTick(auto: DynamicRecord): Promise<void> {
        if (farmTaskRunning) return;
        farmTaskRunning = true;
        const intervalMs = getFarmInterval();
        try {
            if (auto.farm) await checkFarm();
            if (auto.task) await checkAndClaimTasks();
            if (auto.email) await checkAndClaimEmails();
            if (auto.fertilizer_gift) await openFertilizerGiftPacksSilently();
        } catch {
            // ignore
        } finally {
            nextFarmRunAt = now() + intervalMs;
            farmTaskRunning = false;
        }
    }

    async function runHelpTick(auto: DynamicRecord): Promise<void> {
        if (helpTaskRunning || !auto.friend_help) return;
        if (auto.friend_help_exp_limit && isHelpExpLimitReached()) {
            nextHelpRunAt = now() + getHelpInterval();
            return;
        }
        helpTaskRunning = true;
        const intervalMs = getHelpInterval();
        try {
            await checkFriends({ onlyHelp: true });
        } catch (error) {
            log('系统', `帮助巡查执行失败: ${errorMessage(error)}`, { module: 'system', event: '帮助巡查', result: 'error' });
        } finally {
            nextHelpRunAt = now() + intervalMs;
            helpTaskRunning = false;
        }
    }

    async function runStealTick(auto: DynamicRecord): Promise<void> {
        if (stealTaskRunning || !auto.friend_steal) return;
        stealTaskRunning = true;
        const intervalMs = getStealInterval();
        try {
            await checkFriends({ onlySteal: true });
        } catch (error) {
            log('系统', `偷菜巡查执行失败: ${errorMessage(error)}`, { module: 'system', event: '偷菜巡查', result: 'error' });
        } finally {
            nextStealRunAt = now() + intervalMs;
            stealTaskRunning = false;
        }
    }

    async function runTick(): Promise<void> {
        if (!running || !isLoginReady()) return;
        const currentTime = now();
        const dueFarm = currentTime >= nextFarmRunAt;
        const dueHelp = currentTime >= nextHelpRunAt;
        const dueSteal = currentTime >= nextStealRunAt;
        if (!dueFarm && !dueHelp && !dueSteal) return;

        const auto = getAutomation();
        // 串行执行而非并行，避免并发请求过多导致超时
        if (dueFarm) await runFarmTick(auto);
        if (dueHelp) await runHelpTick(auto);
        if (dueSteal) await runStealTick(auto);
    }

    function scheduleNext(): void {
        if (!running) return;
        scheduler.clear('unified_next_tick');
        if (!isLoginReady()) return;

        const currentTime = now();
        const nextAt = Math.min(
            Number(nextFarmRunAt) || (currentTime + 1000),
            Number(nextHelpRunAt) || (currentTime + 1000),
            Number(nextStealRunAt) || (currentTime + 1000),
        );
        const delayMs = Math.max(1000, nextAt - currentTime);

        scheduler.setTimeoutTask('unified_next_tick', delayMs, async () => {
            try {
                await runTick();
            } finally {
                scheduleNext();
            }
        });
    }

    function start(): void {
        if (running) return;
        running = true;
        reset();
        scheduleNext();
    }

    function stop(): void {
        running = false;
        farmTaskRunning = false;
        helpTaskRunning = false;
        stealTaskRunning = false;
        scheduler.clear('unified_next_tick');
    }

    return {
        getScheduleTimes: () => ({
            farm: nextFarmRunAt,
            help: nextHelpRunAt,
            steal: nextStealRunAt,
        }),
        reset,
        scheduleNext,
        start,
        stop,
    };
}
