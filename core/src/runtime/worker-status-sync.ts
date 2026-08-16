import type { WorkerToMasterMessage } from '../types/ipc';

const { getLevelExpProgress } = require('../config/gameConfig');
const { getAutomation, getPreferredSeed } = require('../models/store');
const { getOperationLimits } = require('../services/friend');
const { getStats } = require('../services/stats');
const { statusData } = require('../services/status');
const { getUserState, getWs } = require('../utils/network');

type DynamicRecord = Record<string, any>;

interface WorkerScheduleTimes {
    farm: number;
    help: number;
    steal: number;
}

interface WorkerStatusSynchronizerOptions {
    buildBaseStatus?: (loginReady: boolean) => { stats: DynamicRecord; levelProgress: unknown };
    canSend: () => boolean;
    getAutomationState?: () => unknown;
    getConfigRevision: () => number;
    getLoginReady: () => boolean;
    getPreferredSeedValue?: () => unknown;
    getScheduleTimes: () => WorkerScheduleTimes;
    heartbeatMs?: number;
    now?: () => number;
    sendToMaster: (payload: WorkerToMasterMessage) => void;
}

function buildDefaultBaseStatus(loginReady: boolean): { stats: DynamicRecord; levelProgress: unknown } {
    const userState = getUserState();
    const ws = getWs();
    const connected = !!(loginReady && ws && ws.readyState === 1);
    const level = userState.level ?? statusData.level ?? 0;
    const exp = userState.exp ?? statusData.exp ?? 0;
    const levelProgress = level > 0 && exp >= 0 ? getLevelExpProgress(level, exp) : null;
    const limits = getOperationLimits();
    return {
        stats: getStats(statusData, userState, connected, limits),
        levelProgress,
    };
}

export function buildNextChecks(schedule: WorkerScheduleTimes, nowMs: number): Record<string, number> {
    const farmRemainSec = Math.max(0, Math.ceil((Number(schedule.farm || 0) - nowMs) / 1000));
    const helpRemainSec = Math.max(0, Math.ceil((Number(schedule.help || 0) - nowMs) / 1000));
    const stealRemainSec = Math.max(0, Math.ceil((Number(schedule.steal || 0) - nowMs) / 1000));
    return {
        farmRemainSec,
        helpRemainSec,
        stealRemainSec,
        friendRemainSec: Math.max(helpRemainSec, stealRemainSec),
    };
}

export function createWorkerStatusSynchronizer(options: WorkerStatusSynchronizerOptions): () => void {
    const {
        buildBaseStatus = buildDefaultBaseStatus,
        canSend,
        getAutomationState = getAutomation,
        getConfigRevision,
        getLoginReady,
        getPreferredSeedValue = getPreferredSeed,
        getScheduleTimes,
        heartbeatMs = 8000,
        now = Date.now,
        sendToMaster,
    } = options;
    let lastStatusHash = '';
    let lastStatusSentAt = 0;

    return function syncStatus(): void {
        if (!canSend()) return;

        const { stats: fullStats, levelProgress } = buildBaseStatus(getLoginReady());
        const scheduleNowMs = now();

        fullStats.nextChecks = buildNextChecks(getScheduleTimes(), scheduleNowMs);
        fullStats.automation = getAutomationState();
        fullStats.preferredSeed = getPreferredSeedValue();
        fullStats.levelProgress = levelProgress;
        fullStats.configRevision = getConfigRevision();

        const hash = JSON.stringify(fullStats);
        const sendNowMs = now();
        if (hash !== lastStatusHash || sendNowMs - lastStatusSentAt > heartbeatMs) {
            lastStatusHash = hash;
            lastStatusSentAt = sendNowMs;
            sendToMaster({ type: 'status_sync', data: fullStats });
        }
    };
}
