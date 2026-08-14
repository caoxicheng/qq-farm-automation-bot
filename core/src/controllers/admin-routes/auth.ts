import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

type DynamicRecord = Record<string, any>;
type HeaderText = (value: string | string[] | undefined) => string;

interface AdminAuthContext {
    adminRequired: RequestHandler;
    authRequired: RequestHandler;
    checkUserAccess: RequestHandler;
    issueToken: () => string;
    tokens: Set<string>;
    tokenUserMap: Map<string, DynamicRecord>;
}

function createAdminAuth(headerText: HeaderText): AdminAuthContext {
    const tokens = new Set<string>();
    const tokenUserMap = new Map<string, DynamicRecord>();

    const authRequired: RequestHandler = (req, res, next) => {
        const token = headerText(req.headers['x-admin-token']);
        if (!token || !tokens.has(token)) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
        req.adminToken = token;
        req.currentUser = tokenUserMap.get(token)!;

        if (req.currentUser && req.currentUser.role !== 'admin' && req.currentUser.card) {
            if (req.currentUser.card.enabled === false) {
                console.log('[请求拒绝] 用户已被封禁:', req.currentUser.username);
                tokens.delete(token);
                tokenUserMap.delete(token);
                return res.status(403).json({ ok: false, error: '账号已被封禁，请联系管理员' });
            }
            if (req.currentUser.card.expiresAt && req.currentUser.card.expiresAt < Date.now()) {
                console.log('[请求拒绝] 用户已过期:', req.currentUser.username);
                tokens.delete(token);
                tokenUserMap.delete(token);
                return res.status(403).json({ ok: false, error: '账号已过期，请续费后重新登录' });
            }
        }

        next();
    };

    const adminRequired: RequestHandler = (req, res, next) => {
        if (!req.currentUser || req.currentUser.role !== 'admin') {
            return res.status(403).json({ ok: false, error: '需要管理员权限' });
        }
        next();
    };

    return {
        adminRequired,
        authRequired,
        checkUserAccess: authRequired,
        issueToken: () => crypto.randomBytes(24).toString('hex'),
        tokens,
        tokenUserMap,
    };
}

export { createAdminAuth };
