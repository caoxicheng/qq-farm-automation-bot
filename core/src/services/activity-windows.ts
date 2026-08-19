import type { ActivityWindow, SellConditionContext } from '../config/sell-conditions';
import { createSingleFlight, withTimeout } from '../utils/request-coordination';

const { sendMsgAsync, networkEvents } = require('../utils/network');
const { types } = require('../utils/proto');
const { getServerTimeSec, logWarn, toNum, toTimeSec } = require('../utils/utils');

const CACHE_TTL_MS = 5 * 60 * 1000;
const FAILURE_LOG_INTERVAL_MS = 60 * 1000;
const ACTIVITY_WINDOWS_REQUEST_TIMEOUT_MS = 5000;
const PREVIEW_CONTEXT_TIMEOUT_MS = 3000;
let cachedWindows: ReadonlyMap<string, ActivityWindow> = new Map();
let loadedAt = 0;
let lastFailureLogAt = 0;

export function decodeActivityWindows(reply: unknown): ReadonlyMap<string, ActivityWindow> {
    const source = reply && typeof reply === 'object' ? reply as Record<string, unknown> : {};
    const rows = Array.isArray(source.activity_windows) ? source.activity_windows : [];
    const windows = new Map<string, ActivityWindow>();
    for (const value of rows) {
        const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        const id = String(toNum(row.id) || '').trim();
        if (!id) continue;
        windows.set(id, {
            id,
            name: String(row.name || ''),
            beginTime: Math.max(0, toTimeSec(row.begin_time)),
            endTime: Math.max(0, toTimeSec(row.end_time)),
        });
    }
    return windows;
}

async function requestActivityWindows(): Promise<ReadonlyMap<string, ActivityWindow>> {
    const body = types.ActivityListRequest.encode(types.ActivityListRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync(
        'gamepb.activitypb.ActivityService',
        'List',
        body,
        ACTIVITY_WINDOWS_REQUEST_TIMEOUT_MS,
    );
    const windows = decodeActivityWindows(types.ActivityListReply.decode(replyBody));
    if (windows.size === 0) throw new Error('活动列表未返回时间窗口');
    cachedWindows = windows;
    loadedAt = Date.now();
    return windows;
}

const refreshSingleFlight = createSingleFlight(requestActivityWindows);

export async function refreshActivityWindows(): Promise<ReadonlyMap<string, ActivityWindow>> {
    return refreshSingleFlight();
}

export function invalidateActivityWindows(): void {
    loadedAt = 0;
}

export function getCachedSellConditionContext(): SellConditionContext {
    return {
        nowSec: getServerTimeSec(),
        activityWindows: cachedWindows,
        activityWindowsLoaded: loadedAt > 0,
    };
}

export async function getSellConditionContext(): Promise<SellConditionContext> {
    if (loadedAt <= 0 || Date.now() - loadedAt >= CACHE_TTL_MS) {
        try {
            await refreshActivityWindows();
        } catch (error) {
            const now = Date.now();
            if (now - lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
                lastFailureLogAt = now;
                const message = error instanceof Error ? error.message : String(error);
                logWarn('仓库', `活动时间同步失败: ${message}`);
            }
        }
    }
    return getCachedSellConditionContext();
}

export async function getPreviewSellConditionContext(
    timeoutMs = PREVIEW_CONTEXT_TIMEOUT_MS,
): Promise<SellConditionContext> {
    try {
        return await withTimeout(
            getSellConditionContext(),
            timeoutMs,
            '活动售价上下文查询超时',
        );
    } catch {
        // 背包预览不能被辅助活动查询拖过 Worker API 截止时间；刷新仍会在后台更新缓存。
        return getCachedSellConditionContext();
    }
}

networkEvents.on('activitiesChanged', invalidateActivityWindows);
networkEvents.on('disconnected', invalidateActivityWindows);
