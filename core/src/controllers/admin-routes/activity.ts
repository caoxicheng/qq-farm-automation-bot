import type { Express, Request, RequestHandler, Response } from 'express';
import type { DataProvider } from '../../runtime/data-provider';

type ActivityHandler = (accountId: string, request: Request, response: Response) => unknown | Promise<unknown>;

export interface ActivityRoutesContext {
    app: Express;
    provider: DataProvider;
    getAccountId: (request: Request) => string;
    canAccessAccount: (request: Request, accountId: string) => boolean;
}

const ACTIVITY_ERROR_MESSAGES: Record<string, string> = {
    '1034038': '当前没有可点亮或可领取的星宿奖励，可能已经领取过，请稍后或明天再来看看',
    '1034001': '当前活动暂不可操作，请稍后再试',
    '1034002': '活动尚未开放或已经结束',
    '1034014': '今日青梅种子已经领取，无需重复领取',
    INVALID_EXCHANGE_COUNT: '兑换数量必须是正十进制整数',
    INVALID_SHOP_GOODS_ID: '商品信息无效，请刷新商店后重试',
    SHOP_GOODS_NOT_FOUND: '该商品已不在当前商店目录中，请刷新后重试',
    SHOP_GOODS_UNAVAILABLE: '该商品当前不可兑换，请刷新商店后重试',
    SHOP_BALANCE_UNAVAILABLE: '暂时无法确认星砂余额，请稍后重试',
    INSUFFICIENT_STAR_SAND: '星砂余额不足，无法完成本次兑换',
    NO_PASS_REWARD: '当前没有可领取的游记奖励，请完成新的游记等级后再试',
    SHOP_RESPONSE_INVALID: '商店数据已经变化，请刷新页面后重试',
    SHOP_UNAVAILABLE: '星砂商店暂未开放，请稍后再来看看',
};

function activityErrorResponse(error: unknown): { code: string; message: string } {
    const candidate = error as { code?: unknown; message?: unknown };
    const rawMessage = String(candidate?.message || error || '活动操作失败');
    const protocolCode = String(candidate?.code || (rawMessage.match(/\bcode=(\d+)\b/) || [])[1] || '');
    const friendlyMessage = ACTIVITY_ERROR_MESSAGES[protocolCode];
    if (friendlyMessage) return { code: protocolCode, message: friendlyMessage };
    if (rawMessage.includes('当前没有可领取的游记奖励')) return { code: 'NO_PASS_REWARD', message: '当前没有可领取的游记奖励，请完成新的游记等级后再试' };
    if (rawMessage.includes('指定节令当前不可领取')) return { code: 'SOLAR_TERM_UNAVAILABLE', message: '当前节令奖励暂不可领取，请在开放后再试' };
    if (rawMessage.includes('服务端未发现星座活动')) return { code: 'CONSTELLATION_UNAVAILABLE', message: '观星礼录活动暂未开放或已经结束' };
    if (rawMessage.includes('服务端未发现可用游记')) return { code: 'PASS_UNAVAILABLE', message: '千星游记活动暂未开放或已经结束' };
    if (rawMessage.includes('服务端未发现指定节令')) return { code: 'SOLAR_TERM_NOT_FOUND', message: '未找到该节令活动，请刷新页面后再试' };
    if (rawMessage.includes('当前赛季未发现活动商店')) return { code: 'SHOP_UNAVAILABLE', message: '星砂商店暂未开放，请稍后再来看看' };
    if (rawMessage.includes('当前赛季数据为空')) return { code: 'SEASON_UNAVAILABLE', message: '当前活动数据暂未开放，请稍后刷新重试' };
    if (rawMessage.includes('termId 必须')) return { code: 'INVALID_SOLAR_TERM', message: '节令信息已失效，请刷新页面后重试' };
    if (rawMessage === '账号未运行' || rawMessage === '账号已离线') return { code: 'ACCOUNT_OFFLINE', message: '当前账号尚未运行，请先启动账号后再试' };
    if (rawMessage === 'API Timeout' || rawMessage.includes('请求超时')) return { code: 'ACTIVITY_TIMEOUT', message: '活动服务响应超时，请稍后重试' };
    if (rawMessage.includes('连接未打开') || rawMessage.includes('账号尚未登录')) return { code: 'GAME_OFFLINE', message: '游戏连接尚未就绪，请稍后重试' };
    if (rawMessage.includes('请求队列已满')) return { code: 'ACTIVITY_BUSY', message: '活动操作过于频繁，请稍后再试' };
    if (rawMessage.includes('发送失败') || rawMessage.includes('请求被中断')) return { code: 'ACTIVITY_REQUEST_INTERRUPTED', message: '活动请求未能完成，请稍后重试' };
    if (rawMessage.includes('不匹配的活动 ID') || rawMessage.includes('未知操作类型') || rawMessage.includes('回包缺少动态状态')) return { code: 'ACTIVITY_DATA_CHANGED', message: '活动数据已经更新，请刷新页面后再试' };
    return { code: protocolCode || 'ACTIVITY_OPERATION_FAILED', message: '活动操作失败，请刷新页面后重试' };
}

export function registerActivityRoutes(context: ActivityRoutesContext): void {
    const { app, provider, getAccountId, canAccessAccount } = context;
    const withActivityAccount = (handler: ActivityHandler): RequestHandler => async (request, response) => {
        const accountId = getAccountId(request);
        if (!accountId) return response.status(400).json({ ok: false, error: 'Missing x-account-id' });
        if (!canAccessAccount(request, accountId)) return response.status(403).json({ ok: false, error: '无权访问此账号' });
        try {
            const data = await handler(accountId, request, response);
            if (!response.headersSent) return response.json({ ok: true, data });
            return undefined;
        } catch (error) {
            const result = activityErrorResponse(error);
            return response.json({ ok: false, error: result.message, errorCode: result.code });
        }
    };
    const mountGet = (routePath: string, providerMethod: string): void => {
        app.get(routePath, withActivityAccount(accountId => provider[providerMethod](accountId)));
    };

    mountGet('/api/activity-center/snapshot', 'getActivityCenterSnapshot');
    mountGet('/api/activity-center/season', 'getCurrentSeasonEvent');
    mountGet('/api/activity-center/shop', 'getCurrentStarSandShop');
    mountGet('/api/activity-center/solar-terms', 'getCurrentSolarTerms');
    mountGet('/api/activity-center/qingmei', 'getCurrentQingMeiActivity');
    app.post('/api/activity-center/pass/claim', withActivityAccount(accountId => provider.claimBattlePassRewards(accountId)));
    app.post('/api/activity-center/constellation/light', withActivityAccount(accountId => provider.lightConstellation(accountId)));
    app.post('/api/activity-center/shop/exchange', withActivityAccount((accountId, request) => provider.exchangeStarSandGoods(accountId, request.body?.goodsId, request.body?.count)));
    app.post('/api/activity-center/solar-terms/:termId/claim', withActivityAccount((accountId, request, response) => {
        const termId = String(request.params.termId || '');
        if (!/^[1-9]\d*$/.test(termId)) {
            response.status(400).json({ ok: false, error: 'termId 必须是正十进制整数' });
            return undefined;
        }
        return provider.claimSolarTerm(accountId, termId);
    }));
    app.post('/api/activity-center/qingmei/daily-seed/claim', withActivityAccount(accountId => provider.claimQingMeiDailySeed(accountId)));
    app.post('/api/activity-center/qingmei/brew/start', withActivityAccount((accountId, request) => provider.startQingMeiBrew(accountId, request.body?.ingredients)));
    app.post('/api/activity-center/qingmei/brew/continue', withActivityAccount(accountId => provider.continueQingMeiBrew(accountId)));
    app.post('/api/activity-center/qingmei/brew/settle', withActivityAccount(accountId => provider.settleQingMeiBrew(accountId)));
}
