import process from 'node:process';
import type { Express, Request, Response } from 'express';
import type { DataProvider } from '../../runtime/data-provider';

type DynamicRecord = Record<string, any>;

interface RuntimeRouteOptions {
    app: Express;
    canAccessAccount: (request: Request, accountId: unknown) => boolean;
    getAccountId: (request: Request) => string;
    getRuntimeConfig: () => DynamicRecord;
    getSchedulerRegistrySnapshot: () => unknown;
    handleApiError: (response: Response, error: unknown) => unknown;
    provider: DataProvider;
    version: string;
}

function registerRuntimeRoutes(options: RuntimeRouteOptions): void {
    const {
        app,
        canAccessAccount: checkAccountAccess,
        getAccountId: getAccId,
        getRuntimeConfig,
        getSchedulerRegistrySnapshot,
        handleApiError,
        provider,
        version,
    } = options;

    app.get('/api/ping', (req, res) => {
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version } });
    });

    app.get('/api/game-version', (req, res) => {
        const runtimeConfig = getRuntimeConfig();
        res.json({ ok: true, clientVersion: runtimeConfig.clientVersion });
    });

    app.get('/api/auth/validate', (req, res) => {
        res.json({ ok: true, data: { valid: true } });
    });

    // API: 调度任务快照（用于调度收敛排查）
    app.get('/api/scheduler', async (req, res) => {
        try {
            const id = getAccId(req);

            // 检查权限（如果指定了账号ID）
            if (id && !checkAccountAccess(req, id)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            if (provider && typeof provider.getSchedulerStatus === 'function') {
                const data = await provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({ ok: true, data: { runtime: getSchedulerRegistrySnapshot(), worker: null, workerError: 'DataProvider does not support scheduler status' } });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

}

export { registerRuntimeRoutes };
