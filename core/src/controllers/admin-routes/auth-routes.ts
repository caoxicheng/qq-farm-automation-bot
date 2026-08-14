import type { Express, Request, RequestHandler } from 'express';
import type { DataProvider } from '../../runtime/data-provider';
import type { ModuleLogger } from '../../services/logger';

type DynamicRecord = Record<string, any>;

interface AuthRouteOptions {
    app: Express;
    authRequired: RequestHandler;
    checkAccountAccess: (request: Request, accountId: unknown) => boolean;
    checkUserAccess: RequestHandler;
    getClientIp: (request: Request) => string;
    issueToken: () => string;
    logger: ModuleLogger;
    provider: DataProvider;
    resolveAccountId: (accountId: unknown) => string;
    tokens: Set<string>;
    tokenUserMap: Map<string, DynamicRecord>;
    userStore: DynamicRecord;
    wxLoginAdapter: DynamicRecord;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

function registerAuthRoutes(options: AuthRouteOptions): void {
    const {
        app,
        authRequired,
        checkAccountAccess,
        checkUserAccess,
        getClientIp,
        issueToken,
        logger: adminLogger,
        provider,
        resolveAccountId: resolveAccId,
        tokens,
        tokenUserMap,
        userStore,
        wxLoginAdapter,
    } = options;

    // 登录与鉴权
    app.post('/api/login', (req, res) => {
        const { username, password } = req.body || {};
        const clientIp = getClientIp(req);
        const userAgent = req.headers['user-agent'] || 'unknown';

        if (username && password) {
            const user = userStore.validateUser(username, password, clientIp);
            
            if (user && user.error) {
                const statusCode = user.error === 'rate_limit' ? 429 : 
                                   user.error === 'locked' ? 423 : 401;
                
                adminLogger.warn('登录失败', { 
                    username, 
                    error: user.error, 
                    ip: clientIp,
                    message: user.message 
                });

                userStore.addLoginLog({
                    event: 'login_failed',
                    username,
                    errorType: user.error,
                    ip: clientIp,
                    userAgent
                });
                
                return res.status(statusCode).json({ 
                    ok: false, 
                    error: user.message,
                    errorType: user.error,
                    remainingMs: user.remainingMs 
                });
            }
            
            if (!user) {
                adminLogger.warn('登录失败', { username, ip: clientIp, reason: 'invalid_credentials' });
                
                userStore.addLoginLog({
                    event: 'login_failed',
                    username,
                    errorType: 'invalid_credentials',
                    ip: clientIp,
                    userAgent
                });
                
                return res.status(401).json({ ok: false, error: '用户名或密码错误' });
            }

            adminLogger.info('登录检查', { username, role: user.role, cardInfo: user.card ? 'exists' : 'none' });

            if (user.role !== 'admin') {
                if (user.card && user.card.enabled === false) {
                    adminLogger.warn('登录拒绝', { username, reason: 'banned' });
                    return res.status(403).json({ ok: false, error: '账号已被封禁，请联系管理员' });
                }

                if (user.card && user.card.expiresAt) {
                    const now = Date.now();
                    if (user.card.expiresAt < now) {
                        adminLogger.warn('登录拒绝', { username, reason: 'expired' });
                        return res.status(403).json({ ok: false, error: '账号已过期，请续费后重新登录' });
                    }
                }
            }

            const token = issueToken();
            tokens.add(token);
            tokenUserMap.set(token, user);
            
            adminLogger.info('登录成功', { username, role: user.role, ip: clientIp });

            userStore.addLoginLog({
                event: 'login_success',
                username,
                errorType: null,
                ip: clientIp,
                userAgent
            });
            
            return res.json({ 
                ok: true, 
                data: { 
                    token, 
                    role: user.role, 
                    card: user.card, 
                    accountLimit: user.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2,
                    user: { username: user.username },
                    mustChangePassword: user.mustChangePassword || false
                } 
            });
        }

        return res.status(401).json({ ok: false, error: '请输入用户名和密码' });
    });

    // 注册接口
    app.post('/api/register', (req, res) => {
        const { username, password, cardCode } = req.body || {};
        if (!username || !password || !cardCode) {
            return res.status(400).json({ ok: false, error: '请填写完整信息' });
        }
        const result = userStore.registerUser(username, password, cardCode);
        if (!result.ok) {
            return res.status(400).json(result);
        }
        res.json({ ok: true, data: result.user });
    });

    // 获取登录日志（管理员）
    app.get('/api/admin/login-logs', authRequired, (req, res) => {
        if (!req.currentUser || req.currentUser.role !== 'admin') {
            return res.status(403).json({ ok: false, error: '无权限访问' });
        }
        
        const limit = Math.min(Math.max(Number.parseInt(req.query.limit) || 100, 1), 500);
        const offset = Math.max(Number.parseInt(req.query.offset) || 0, 0);
        
        const result = userStore.getLoginLogs(limit, offset);
        res.json({ ok: true, data: result });
    });

    // 清空登录日志（管理员）
    app.delete('/api/admin/login-logs', authRequired, (req, res) => {
        if (!req.currentUser || req.currentUser.role !== 'admin') {
            return res.status(403).json({ ok: false, error: '无权限访问' });
        }
        
        const result = userStore.clearLoginLogs();
        adminLogger.info('登录日志已清空', { admin: req.currentUser.username });
        res.json(result);
    });

    // 查询卡密信息接口（用于续费前预览）
    app.get('/api/card/info/:code', (req, res) => {
        try {
            const { code } = req.params;
            const cards = userStore.getAllCards();
            const card = cards.find((c: DynamicRecord) => c.code === code);
            
            if (!card) {
                return res.status(404).json({ ok: false, error: '卡密不存在' });
            }
            
            if (!card.enabled) {
                return res.status(400).json({ ok: false, error: '卡密已被禁用' });
            }
            
            if (card.usedBy) {
                return res.status(400).json({ ok: false, error: '卡密已被使用' });
            }
            
            res.json({ 
                ok: true, 
                data: {
                    type: card.type || 'time',
                    days: card.days,
                    description: card.description
                }
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 用户续费接口
    app.post('/api/user/renew', checkUserAccess, (req, res) => {
        const { cardCode } = req.body || {};
        const username = req.currentUser?.username;

        if (!username) {
            return res.status(401).json({ ok: false, error: '未登录' });
        }

        if (!cardCode) {
            return res.status(400).json({ ok: false, error: '请提供卡密' });
        }

        const result = userStore.renewUser(username, cardCode);
        if (!result.ok) {
            return res.status(400).json(result);
        }

        // 更新 token 中的用户信息
        for (const [token, user] of tokenUserMap.entries()) {
            if (user.username === username) {
                user.card = result.card;
                user.accountLimit = result.accountLimit;
                tokenUserMap.set(token, user);
                break;
            }
        }

        res.json({ ok: true, data: { card: result.card, accountLimit: result.accountLimit, cardType: result.cardType } });
    });

    // 修改密码接口
    app.post('/api/user/change-password', checkUserAccess, (req, res) => {
        const { oldPassword, newPassword } = req.body || {};
        const username = req.currentUser?.username;

        if (!username) {
            return res.status(401).json({ ok: false, error: '未登录' });
        }

        if (!oldPassword || !newPassword) {
            return res.status(400).json({ ok: false, error: '请提供原密码和新密码' });
        }

        const result = userStore.changePassword(username, oldPassword, newPassword);
        res.json(result);
    });

    // 微信扫码登录（进程内应用宝协议适配层）：会话绑定当前登录用户。
    app.post('/api/Login/LoginGetQRCar', authRequired, async (req, res) => {
        try {
            const result = await wxLoginAdapter.getQRCode(req.currentUser.username);
            res.json(result);
        } catch (e) {
            res.json({ Success: false, Message: `获取二维码失败: ${errorMessage(e)}` });
        }
    });

    app.post('/api/Login/LoginCheckQR', authRequired, async (req, res) => {
        try {
            // 前端把 uuid 放在 query string（?uuid=xxx），兼容 body 两种来源
            const uuid = (req.body && req.body.uuid) || (req.query && req.query.uuid) || '';
            const result = await wxLoginAdapter.checkQR(uuid, req.currentUser.username);
            res.json(result);
        } catch (e) {
            res.json({ Success: false, Message: `检查登录状态失败: ${errorMessage(e)}` });
        }
    });

    app.post('/api/Wxapp/JSLogin', authRequired, async (req, res) => {
        try {
            const { Wxid, Uuid, AccountId } = req.body || {};
            if (!Uuid) {
                return res.status(400).json({ Success: false, Message: '缺少扫码会话标识' });
            }
            const accountId = AccountId ? resolveAccId(AccountId) : '';
            if (accountId && !checkAccountAccess(req, accountId)) {
                return res.status(403).json({ Success: false, Message: '无权访问此账号' });
            }
            const result = await wxLoginAdapter.getFarmCode(Wxid, {
                sessionId: Uuid,
                owner: req.currentUser.username,
                accountId,
            });
            res.json(result);
        } catch (e) {
            res.json({ Success: false, Message: `获取 Code 失败: ${errorMessage(e)}` });
        }
    });

    // 账号头像（微信）：免鉴权（<img> 无法携带 x-admin-token），仅返回头像图片流，
    // 不泄露 openid；带 10 分钟内存缓存
    const avatarCache = new Map();
    const AVATAR_CACHE_TTL_MS = 10 * 60 * 1000;
    app.get('/api/accounts/:id/avatar', async (req, res) => {
        try {
            const id = Number(req.params.id) || 0;
            if (id <= 0) return res.status(404).end();
            const accList = provider.getAccounts() || {};
            const accounts = Array.isArray(accList) ? accList : (accList.accounts || []);
            const acc = accounts.find((a: DynamicRecord) => Number(a.id) === id);
            if (!acc || !acc.wxid) return res.status(404).end();
            // 缓存 key 绑定头像 URL：头像更新（avatar 字段变化）→ 缓存自动失效，立即显示新头像
            const cacheKey = `${id}:${acc.avatar || ''}`;
            const hit = avatarCache.get(cacheKey);
            if (hit && Date.now() - hit.at < AVATAR_CACHE_TTL_MS) {
                return res.set('Content-Type', hit.type).set('Cache-Control', 'public, max-age=600').send(hit.buf);
            }
            const resp = await wxLoginAdapter.getAccountAvatar(acc.wxid);
            if (!resp) return res.status(404).end();
            const buf = Buffer.from(await resp.arrayBuffer());
            const type = resp.headers.get('content-type') || 'image/jpeg';
            avatarCache.set(cacheKey, { buf, type, at: Date.now() });
            // 防缓存无限增长：超过 50 条淘汰最旧
            if (avatarCache.size > 50) {
                const oldest = [...avatarCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                if (oldest) avatarCache.delete(oldest[0]);
            }
            res.set('Content-Type', type).set('Cache-Control', 'public, max-age=600').send(buf);
        } catch {
            res.status(404).end();
        }
    });

    app.use('/api', (req, res, next) => {
        if (req.path === '/login' || req.path === '/qr/create' || req.path === '/qr/check' || req.path === '/card-claim/status' || req.path === '/card-claim/claim' || req.path === '/game-version') return next();
        return authRequired(req, res, next);
    });

}

export { registerAuthRoutes };

