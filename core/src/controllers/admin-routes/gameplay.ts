import type { Express, Request, RequestHandler, Response } from 'express';
import type { DataProvider } from '../../runtime/data-provider';
import { OperationTimeoutError, withTimeout } from '../../utils/request-coordination';
import { registerFriendRoutes } from './friends';

const { getLevelExpProgress } = require('../../config/gameConfig');

type DynamicRecord = Record<string, any>;
const WX_CODE_REFRESH_TIMEOUT_MS = 25000;

interface GameplayRouteOptions {
    addOrUpdateAccount: (account: DynamicRecord) => DynamicRecord;
    adminLogger: DynamicRecord;
    app: Express;
    authRequired: RequestHandler;
    checkAccountAccess: (request: Request, accountId: unknown) => boolean;
    getAccountId: (request: Request) => string;
    handleApiError: (response: Response, error: unknown) => unknown;
    provider: DataProvider;
    resolveAccountId: (accountRef: unknown) => string;
    store: DynamicRecord;
    wxLoginAdapter: DynamicRecord;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

function registerGameplayRoutes(options: GameplayRouteOptions): void {
    const {
        addOrUpdateAccount,
        adminLogger,
        app,
        authRequired,
        checkAccountAccess,
        getAccountId: getAccId,
        handleApiError,
        provider,
        resolveAccountId: resolveAccId,
        store,
        wxLoginAdapter,
    } = options;

    // API: 完整状态
    app.get('/api/status', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = provider.getStatus(id);
            if (data && data.status) {
                const { level, exp } = data.status;
                const progress = getLevelExpProgress(level, exp);
                data.levelProgress = progress;
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.json({ ok: false, error: errorMessage(e) });
        }
    });

    // API: 钻石余额（充值信息协议 PayService.GetRechargeInfo）
    app.get('/api/diamond', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const diamond = await provider.getDiamondBalance(id);
            res.json({ ok: true, data: { diamond: Math.max(0, Number(diamond) || 0) } });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.post('/api/automation', async (req, res) => {
        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            let lastData = null;
            for (const [k, v] of Object.entries(req.body)) {
                lastData = await provider.setAutomation(id, k, v);
            }
            res.json({ ok: true, data: lastData || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    app.post('/api/fertilizer/buy', async (req, res) => {
        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const type = String(req.body?.type || 'organic');
            const count = Number(req.body?.count) || 0;
            const bought = await provider.buyFertilizer(id, type, count);
            res.json({ ok: true, bought });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // API: 检测化肥容器并自动购买
    app.post('/api/fertilizer/check-and-buy', async (req, res) => {
        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const buyOrganic = req.body?.buyOrganic ?? false;
            const buyNormal = req.body?.buyNormal ?? false;
            const organicCount = Number(req.body?.organicCount) || 0;
            const organicThresholdHours = Number(req.body?.organicThresholdHours) || 0;
            const normalCount = Number(req.body?.normalCount) || 0;
            const normalThresholdHours = Number(req.body?.normalThresholdHours) || 0;

            const result = await provider.checkAndBuyFertilizer(id, {
                buyOrganic,
                buyNormal,
                organicCount,
                organicThresholdHours,
                normalCount,
                normalThresholdHours,
            });
            res.json({ ok: true, ...result });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // API: 农田详情
    app.get('/api/lands', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.getLands(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    registerFriendRoutes({
        app,
        authRequired,
        checkAccountAccess,
        getAccountId: getAccId,
        handleApiError,
        provider,
        store,
    });

    // API: 种子列表
    app.get('/api/seeds', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.getSeeds(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 背包物品
    app.get('/api/bag', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.getBag(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 使用背包物品
    app.post('/api/bag/use', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const { itemId, count, uid } = req.body;
            if (!itemId) return res.status(400).json({ ok: false, error: '缺少 itemId' });
            const data = await provider.useItem(id, Number(itemId), Math.max(1, Number(count) || 1), uid || 0);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 出售背包物品
    app.post('/api/bag/sell', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const { items } = req.body;
            if (!Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ ok: false, error: '缺少出售物品列表' });
            }
            const data = await provider.sellItems(id, items);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 获取背包种子列表
    app.get('/api/bag/seeds', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.getBagSeeds(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 每日礼包状态总览
    app.get('/api/daily-gifts', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.getDailyGifts(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 启动账号
    app.post('/api/accounts/:id/start', async (req, res) => {
        try {
            const accountId = resolveAccId(req.params.id);

            // 检查权限
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            // 微信 code 短时有效。必须先刷新再创建 Worker，否则每次服务重建后都会先用旧 code
            // 触发网关 400，并让页面在 Worker 重连窗口内收到瞬时 API 失败。
            // 不同账号使用独立凭证锁，可以并行刷新；同一账号的重复请求由适配器复用在途 Promise。
            try {
                const account = provider.getAccounts().accounts.find((a: DynamicRecord) => String(a.id) === String(accountId));
                if (account && account.platform === 'wx' && account.wxid) {
                    const refresh = await withTimeout<DynamicRecord>(
                        wxLoginAdapter.getFarmCode(account.wxid, { accountId }),
                        WX_CODE_REFRESH_TIMEOUT_MS,
                        '微信 Code 刷新超时',
                    );
                    if (refresh.Success && refresh.Data && refresh.Data.code) {
                        addOrUpdateAccount({ id: accountId, code: refresh.Data.code });
                        adminLogger.info('startAccount', { accountId, note: 'wx code refreshed before worker start' });
                    } else {
                        adminLogger.warn('startAccount', { accountId, note: 'wx code refresh failed, fallback to stored code', msg: refresh.Message });
                    }
                }
            } catch (refreshErr) {
                if (refreshErr instanceof OperationTimeoutError) {
                    adminLogger.warn('startAccount', { accountId, note: 'wx code refresh timeout, worker not started' });
                    return res.status(503).json({ ok: false, error: '微信 Code 刷新超时，请稍后重试' });
                }
                adminLogger.warn('startAccount', { accountId, note: 'wx code refresh error, fallback to stored code', err: errorMessage(refreshErr) });
            }

            const ok = provider.startAccount(accountId);
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // API: 停止账号
    app.post('/api/accounts/:id/stop', (req, res) => {
        try {
            const accountId = resolveAccId(req.params.id);

            // 检查权限
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const ok = provider.stopAccount(accountId);
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // API: 农场一键操作
    app.post('/api/farm/operate', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const { opType } = req.body; // 'harvest', 'clear', 'plant', 'all'
            await provider.doFarmOp(id, opType);
            res.json({ ok: true });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 数据分析
    app.get('/api/analytics', async (req, res) => {
        try {
            const sortBy = req.query.sort || 'exp';
            const { getPlantRankings } = require('../services/analytics');
            const data = getPlantRankings(sortBy);
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });
}

export { registerGameplayRoutes };
