import type { Express, RequestHandler } from 'express';

type DynamicRecord = Record<string, any>;

interface UserRouteOptions {
    adminRequired: RequestHandler;
    app: Express;
    authRequired: RequestHandler;
    disconnectTokenSockets: (token: unknown) => void;
    store: DynamicRecord;
    tokens: Set<string>;
    tokenUserMap: Map<string, DynamicRecord>;
    userStore: DynamicRecord;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

function registerUserRoutes(options: UserRouteOptions): void {
    const {
        adminRequired,
        app,
        authRequired,
        disconnectTokenSockets,
        store,
        tokens,
        tokenUserMap,
        userStore,
    } = options;

    // ============ 卡密管理 API（仅管理员） ============

    // 获取所有卡密
    app.get('/api/admin/cards', authRequired, adminRequired, (req, res) => {
        try {
            const cards = userStore.getAllCards();
            res.json({ ok: true, data: cards });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 创建卡密
    app.post('/api/admin/cards', authRequired, adminRequired, (req, res) => {
        try {
            const { description, days, count, type } = req.body || {};
            if (!description || days === undefined) {
                return res.status(400).json({ ok: false, error: '请提供描述和天数' });
            }

            const cardType = type === 'quota' ? 'quota' : 'time';

            // 批量创建
            if (count && Number.parseInt(count, 10) > 1) {
                const cards = userStore.createCardsBatch(description, days, count, cardType);
                return res.json({ ok: true, data: cards, batch: true, count: cards.length });
            }

            const card = userStore.createCard(description, days, cardType);
            res.json({ ok: true, data: card });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 批量删除卡密（必须放在 /:code 路由之前，避免被当作 code 参数）
    app.post('/api/admin/cards/batch-delete', authRequired, adminRequired, (req, res) => {
        try {
            const { codes } = req.body || {};
            if (!Array.isArray(codes) || codes.length === 0) {
                return res.status(400).json({ ok: false, error: '请提供要删除的卡密列表' });
            }
            const result = userStore.deleteCardsBatch(codes);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 更新卡密
    app.post('/api/admin/cards/:code', authRequired, adminRequired, (req, res) => {
        try {
            const { code } = req.params;
            const updates = req.body || {};
            const card = userStore.updateCard(code, updates);
            if (!card) {
                return res.status(404).json({ ok: false, error: '卡密不存在' });
            }
            res.json({ ok: true, data: card });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 删除卡密
    app.delete('/api/admin/cards/:code', authRequired, adminRequired, (req, res) => {
        try {
            const { code } = req.params;
            const ok = userStore.deleteCard(code);
            if (!ok) {
                return res.status(404).json({ ok: false, error: '卡密不存在' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // ============ 卡密领取功能 API ============
    // 获取卡密领取功能状态
    app.get('/api/card-claim/status', (req, res) => {
        try {
            const status = userStore.getCardClaimStatus();
            res.json({ ok: true, enabled: status.enabled });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 设置卡密领取功能状态（仅管理员）
    app.post('/api/admin/card-claim/status', authRequired, adminRequired, (req, res) => {
        try {
            const { enabled } = req.body;
            const status = userStore.setCardClaimStatus(enabled);
            res.json({ ok: true, enabled: status.enabled });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 用户领取卡密
    app.post('/api/card-claim/claim', (req, res) => {
        try {
            const ua = req.headers['user-agent'] || '';
            const username = req.body?.username || null;

            // 清理过期记录
            userStore.clearExpiredClaimRecords();

            const result = userStore.claimCardByUA(ua, username);

            if (!result.ok) {
                const response: { ok: false; error: unknown; remainingMs?: unknown } = { ok: false, error: result.error };
                if (result.remainingMs) {
                    response.remainingMs = result.remainingMs;
                }
                return res.status(400).json(response);
            }

            res.json({
                ok: true,
                cardCode: result.cardCode,
                days: result.days,
                description: result.description
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 获取卡密领取记录（仅管理员）
    app.get('/api/admin/card-claim/records', authRequired, adminRequired, (req, res) => {
        try {
            const records = userStore.getCardClaimRecords();
            res.json({ ok: true, data: records });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // ============ 用户管理 API（仅管理员） ============
    // 获取所有用户
    app.get('/api/admin/users', authRequired, adminRequired, (req, res) => {
        try {
            const users = userStore.getAllUsers();
            res.json({ ok: true, data: users });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 获取所有用户（带密码，仅管理员）
    app.get('/api/admin/users-with-password', authRequired, adminRequired, (req, res) => {
        try {
            const users = userStore.getAllUsersWithPassword();
            res.json({ ok: true, data: users });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 更新用户
    app.post('/api/admin/users/:username', authRequired, adminRequired, (req, res) => {
        try {
            const { username } = req.params;
            const updates = req.body || {};
            const user = userStore.updateUser(username, updates);
            if (!user) {
                return res.status(404).json({ ok: false, error: '用户不存在' });
            }
            res.json({ ok: true, data: user });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 编辑用户（管理员编辑用户信息）
    app.post('/api/admin/users/:username/edit', authRequired, adminRequired, (req, res) => {
        try {
            const { username } = req.params;
            const { newUsername, password, accountLimit, expiresAt, isPermanent } = req.body || {};

            const result = userStore.editUser(username, {
                newUsername,
                password,
                accountLimit,
                expiresAt,
                isPermanent
            });

            if (!result.ok) {
                return res.status(400).json(result);
            }

            // 更新该用户所有会话中的信息
            for (const [token, user] of tokenUserMap.entries()) {
                if (user.username === username || user.username === newUsername) {
                    user.username = result.user.username;
                    user.card = result.user.card;
                    user.accountLimit = result.user.accountLimit;
                    tokenUserMap.set(token, user);
                }
            }

            res.json({ ok: true, data: result.user });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 删除用户
    app.delete('/api/admin/users/:username', authRequired, adminRequired, (req, res) => {
        try {
            const { username } = req.params;
            const currentUser = req.currentUser;

            // 不能删除自己
            if (currentUser && currentUser.username === username) {
                return res.status(400).json({ ok: false, error: '不能删除自己的账号' });
            }

            // 管理员可以删除其他管理员
            const result = userStore.deleteUser(username, true);
            if (!result.ok) {
                return res.status(400).json(result);
            }
            // 强制下线该用户的所有会话
            for (const [token, user] of tokenUserMap.entries()) {
                if (user.username === username) {
                    tokens.delete(token);
                    tokenUserMap.delete(token);
                    disconnectTokenSockets(token);
                }
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 管理员为用户续费
    app.post('/api/admin/users/:username/renew', authRequired, adminRequired, (req, res) => {
        try {
            const { username } = req.params;
            const { cardCode } = req.body || {};

            if (!cardCode) {
                return res.status(400).json({ ok: false, error: '请提供卡密' });
            }

            const result = userStore.renewUser(username, cardCode);
            if (!result.ok) {
                return res.status(400).json(result);
            }

            // 更新该用户所有会话中的卡密信息
            for (const [token, user] of tokenUserMap.entries()) {
                if (user.username === username) {
                    user.card = result.card;
                    user.accountLimit = result.accountLimit;
                    tokenUserMap.set(token, user);
                }
            }

            res.json({ ok: true, data: { card: result.card, accountLimit: result.accountLimit, cardType: result.cardType } });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 获取当前登录用户信息
    app.get('/api/user/me', authRequired, (req, res) => {
        try {
            const user = req.currentUser;
            if (!user) {
                return res.status(401).json({ ok: false, error: '未登录' });
            }
            res.json({
                ok: true,
                data: {
                    username: user.username,
                    role: user.role,
                    card: user.card,
                    accountLimit: user.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2
                }
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 保存用户微信登录配置（仅管理员可以保存全局配置）
    app.post('/api/user/wxlogin-config', authRequired, adminRequired, (req, res) => {
        try {
            const user = req.currentUser;
            if (!user) {
                return res.status(401).json({ ok: false, error: '未登录' });
            }

            const config = req.body || {};
            const saved = store.setGlobalWxConfig(config);
            res.json({ ok: true, config: saved });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 获取用户微信登录配置（普通用户获取全局配置）
    app.get('/api/user/wxlogin-config', authRequired, (req, res) => {
        try {
            const user = req.currentUser;
            if (!user) {
                return res.status(401).json({ ok: false, error: '未登录' });
            }

            // 普通用户获取全局配置，管理员可以获取并修改全局配置
            const globalConfig = store.getGlobalWxConfig();
            res.json({ ok: true, config: globalConfig });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });
}

export { registerUserRoutes };

