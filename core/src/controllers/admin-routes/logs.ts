import type { Express, Request, Response } from 'express';
import type { Server as SocketServer } from 'socket.io';
import type { DataProvider } from '../../runtime/data-provider';

interface LogRouteOptions {
    app: Express;
    checkAccountAccess: (request: Request, accountId: unknown) => boolean;
    getAccessibleAccountIds: (request: Request) => unknown[];
    getAccountId: (request: Request) => string;
    getSocketServer: () => SocketServer | null;
    handleApiError: (response: Response, error: unknown) => unknown;
    provider: DataProvider;
    resolveAccountId: (accountRef: unknown) => string;
}

function registerLogRoutes(options: LogRouteOptions): void {
    const {
        app,
        checkAccountAccess,
        getAccessibleAccountIds,
        getAccountId: getAccId,
        getSocketServer,
        handleApiError,
        provider,
        resolveAccountId: resolveAccId,
    } = options;

    // API: 日志
    app.get('/api/logs', (req, res) => {
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();
        const id = queryAccountIdRaw ? (queryAccountIdRaw === 'all' ? '' : resolveAccId(queryAccountIdRaw)) : getAccId(req);
        const currentUser = req.currentUser;

        // 必须登录才能查看日志
        if (!currentUser) {
            return res.status(401).json({ ok: false, error: '未登录' });
        }

        // 如果指定了账号ID，检查权限
        if (id && !checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        // 如果没有指定账号ID，获取当前用户可访问的所有账号的日志
        if (!id) {
            // 所有用户（包括管理员）只能获取自己可访问账号的日志
            const accessibleIds = getAccessibleAccountIds(req);
            const allLogs = [];
            const options = {
                limit: Number.parseInt(req.query.limit) || 100,
                tag: req.query.tag || '',
                module: req.query.module || '',
                event: req.query.event || '',
                keyword: req.query.keyword || '',
                isWarn: req.query.isWarn,
                timeFrom: req.query.timeFrom || '',
                timeTo: req.query.timeTo || '',
                hideDev: req.query.hideDev === '1' || req.query.hideDev === 'true',
            };

            // 获取每个可访问账号的日志
            for (const accId of accessibleIds) {
                const logs = provider.getLogs(accId, options);
                if (Array.isArray(logs)) {
                    allLogs.push(...logs);
                }
            }

            // 按时间排序并限制数量
            allLogs.sort((a, b) => (b.time || 0) - (a.time || 0));
            const limitedLogs = allLogs.slice(0, options.limit);

            return res.json({ ok: true, data: limitedLogs });
        }

        // 指定了账号ID且通过权限检查，返回该账号的日志
        const options = {
            limit: Number.parseInt(req.query.limit) || 100,
            tag: req.query.tag || '',
            module: req.query.module || '',
            event: req.query.event || '',
            keyword: req.query.keyword || '',
            isWarn: req.query.isWarn,
            timeFrom: req.query.timeFrom || '',
            timeTo: req.query.timeTo || '',
            hideDev: req.query.hideDev === '1' || req.query.hideDev === 'true',
        };
        const list = provider.getLogs(id, options);
        res.json({ ok: true, data: list });
    });

    // API: 清空当前账号运行日志
    app.delete('/api/logs', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = provider.clearLogs(id);

            const io = getSocketServer();
            if (io && provider && typeof provider.getLogs === 'function') {
                const accountLogs = provider.getLogs(id, { limit: 100 });
                io.to(`account:${id}`).emit('logs:snapshot', {
                    accountId: id,
                    logs: Array.isArray(accountLogs) ? accountLogs : [],
                });

                const allLogs = provider.getLogs('', { limit: 100 });
                io.to('account:all').emit('logs:snapshot', {
                    accountId: 'all',
                    logs: Array.isArray(allLogs) ? allLogs : [],
                });
            }

            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });
}

export { registerLogRoutes };

