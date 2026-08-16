/**
 * 管理面板 HTTP 服务
 * 改写为接收 DataProvider 模式
 */

import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { Express, Request, Response } from 'express';
import express from 'express';
import type { Server as SocketServer } from 'socket.io';
import type { DataProvider } from '../runtime/data-provider';
import { createAdminSocket } from './admin-socket';
import { registerAccountRoutes } from './admin-routes/accounts';
import { registerActivityRoutes } from './admin-routes/activity';
import { registerAuthRoutes } from './admin-routes/auth-routes';
import { createAdminAuth } from './admin-routes/auth';
import { registerConfigRoutes } from './admin-routes/config';
import { registerGameplayRoutes } from './admin-routes/gameplay';
import { registerLogRoutes } from './admin-routes/logs';
import { registerQrRoutes } from './admin-routes/qr';
import { registerSpaFallback, registerStaticResourceRoutes } from './admin-routes/resources';
import { registerRuntimeRoutes } from './admin-routes/runtime';
import { registerUserRoutes } from './admin-routes/users';
const { getCorePackagePath, getWebDistPath } = require('../config/runtime-paths');
const { version } = JSON.parse(fs.readFileSync(getCorePackagePath(), 'utf8'));
const { CONFIG, updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig } = require('../config/config');
const { getBundleRoot } = require('../game-data/resource-bundle');
const store = require('../models/store');
const { addOrUpdateAccount, deleteAccount } = store;
const { findAccountByRef, normalizeAccountRef, resolveAccountId } = require('../services/account-resolver');
const { canAccessAccount } = require('../services/access-policy');
const { createModuleLogger } = require('../services/logger');
const wxLoginAdapter = require('../services/wx-login-adapter');
const { versionChecker } = require('../services/version-checker');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');
const { isSoftRuntimeError } = require('../utils/runtime-errors');
const userStore = require('../models/user-store');

const adminLogger = createModuleLogger('admin');

type DynamicRecord = Record<string, any>;

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

let app: Express | null = null;
let server: HttpServer | null = null;
let provider: DataProvider;
let io: SocketServer | null = null;

function emitRealtimeStatus(accountId: unknown, status: unknown): void {
    if (!io) return;
    const id = String(accountId || '').trim();
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    io.to(`account:${id}`).emit('status:update', { accountId: id, status });
}

function emitRealtimeLog(entry: unknown): void {
    if (!io) return;
    const payload: DynamicRecord = (entry && typeof entry === 'object') ? entry as DynamicRecord : {};
    const id = String(payload.accountId || '').trim();

    // 如果没有指定账号ID，不推送给任何人（防止数据泄露）
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    io.to(`account:${id}`).emit('log:new', payload);
}

function emitRealtimeAccountLog(entry: unknown): void {
    if (!io) return;
    const payload: DynamicRecord = (entry && typeof entry === 'object') ? entry as DynamicRecord : {};
    const id = String(payload.accountId || '').trim();

    // 如果没有指定账号ID，不推送给任何人（防止数据泄露）
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    io.to(`account:${id}`).emit('account-log:new', payload);
}

function startAdminServer(dataProvider: DataProvider): void {
    if (app) return;
    provider = dataProvider;

    app = express();
    app.set('trust proxy', true);
    app.use(express.json());

    function headerText(value: string | string[] | undefined): string {
        return Array.isArray(value) ? String(value[0] || '') : String(value || '');
    }

    function getClientIp(req: Request): string {
        const cfIp = req.headers['cf-connecting-ip'];
        if (cfIp) return headerText(cfIp).trim();
        
        const xRealIp = req.headers['x-real-ip'];
        if (xRealIp) return headerText(xRealIp).trim();
        
        const xForwardedFor = req.headers['x-forwarded-for'];
        if (xForwardedFor) {
            const ips = headerText(xForwardedFor).split(',').map(ip => ip.trim()).filter(Boolean);
            if (ips.length > 0) return ips[0];
        }
        
        if (req.ip && req.ip !== '::1' && req.ip !== '::ffff:127.0.0.1') {
            return req.ip;
        }
        
        const remoteAddr = req.connection?.remoteAddress || req.socket?.remoteAddress;
        if (remoteAddr) {
            if (remoteAddr.startsWith('::ffff:')) {
                return remoteAddr.substring(7);
            }
            return remoteAddr;
        }
        
        return 'unknown';
    }

    const {
        adminRequired,
        authRequired,
        checkUserAccess,
        issueToken,
        tokens,
        tokenUserMap,
    } = createAdminAuth(headerText);

    const disconnectTokenSockets = (token: unknown): void => {
        if (!io) return;
        for (const socket of io.sockets.sockets.values()) {
            if (String(socket.data.adminToken || '') === String(token)) {
                socket.disconnect(true);
            }
        }
    };

    app.use((req, res, next) => {
        const allowedOrigins = CONFIG.ALLOWED_ORIGINS || ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];
        const origin = headerText(req.headers.origin);
        
        if (origin && allowedOrigins.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
        } else if (!origin) {
            res.header('Access-Control-Allow-Origin', '*');
        }
        
        res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PUT');
        res.header('Access-Control-Allow-Headers', 'Content-Type, x-account-id, x-admin-token, x-proxy-api-key, x-proxy-api-url, x-proxy-app-id');
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Max-Age', '86400');
        
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    const webDist = getWebDistPath();
    registerStaticResourceRoutes({ app, bundleRoot: getBundleRoot(), logger: adminLogger, webDist });

    // 定期清理过期用户（每5分钟检查一次）
    const cleanupExpiredUsers = () => {
        const now = Date.now();
        const usersToCleanup = [];

        for (const [token, user] of tokenUserMap.entries()) {
            if (user.role === 'admin') continue; // 管理员不检查

            // 检查是否被封禁
            if (user.card && user.card.enabled === false) {
                console.log(`[自动检查] 用户 ${user.username} 已被封禁，执行清理...`);
                usersToCleanup.push({ token, username: user.username, reason: 'banned' });
                continue;
            }

            // 检查是否过期
            if (user.card && user.card.expiresAt && user.card.expiresAt < now) {
                console.log(`[自动检查] 用户 ${user.username} 已过期，执行清理...`);
                usersToCleanup.push({ token, username: user.username, reason: 'expired' });
            }
        }

        for (const { token, username, reason } of usersToCleanup) {
            tokens.delete(token);
            tokenUserMap.delete(token);
            // 断开相关 socket 连接
            if (io) {
                for (const socket of io.sockets.sockets.values()) {
                    if (String(socket.data.adminToken || '') === String(token)) {
                        socket.disconnect(true);
                    }
                }
            }
            console.log(`[自动清理] 用户 ${username} 已${reason === 'banned' ? '被封禁' : '过期'}，已强制下线`);
        }
    };

    // 启动定期清理
    setInterval(cleanupExpiredUsers, 5 * 60 * 1000); // 每5分钟检查一次

    registerAuthRoutes({
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
    });
    // 管理员密码修改已移除，统一使用 /api/user/change-password 接口

    registerRuntimeRoutes({
        app,
        canAccessAccount: checkAccountAccess,
        getAccountId: getAccId,
        getRuntimeConfig,
        getSchedulerRegistrySnapshot,
        handleApiError,
        provider,
        version,
    });
    app.post('/api/logout', (req, res) => {
        const token = req.adminToken;
        if (token) {
            tokens.delete(token);
            tokenUserMap.delete(token);
            if (io) {
                for (const socket of io.sockets.sockets.values()) {
                    if (String(socket.data.adminToken || '') === String(token)) {
                        socket.disconnect(true);
                    }
                }
            }
        }
        res.json({ ok: true });
    });

    const getAccountList = (username: string | null = null): DynamicRecord[] => {
        try {
            // 检查是否启用用户隔离
            const wxConfig = store.getGlobalWxConfig();
            const userIsolation = wxConfig.userIsolation !== false;

            if (provider && typeof provider.getAccounts === 'function') {
                const data = provider.getAccounts();
                if (data && Array.isArray(data.accounts)) {
                    // 如果指定了用户名且启用了用户隔离，只返回该用户的账号
                    if (username && userIsolation) {
                        return data.accounts.filter((a: DynamicRecord) => a.username === username);
                    }
                    return data.accounts;
                }
            }
        } catch {
            // ignore provider failures
        }
        const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
        let accounts = Array.isArray(data.accounts) ? data.accounts : [];
        // 检查是否启用用户隔离
        const wxConfig = store.getGlobalWxConfig();
        const userIsolation = wxConfig.userIsolation !== false;
        // 如果指定了用户名且启用了用户隔离，只返回该用户的账号
        if (username && userIsolation) {
            accounts = accounts.filter((a: DynamicRecord) => a.username === username);
        }
        return accounts;
    };

    // 检查用户是否有权访问指定账号
    function checkAccountAccess(req: Request, accountId: unknown): boolean {
        const currentUser = req.currentUser;
        if (!currentUser) return false;
        const accounts = getAccountList();
        const account = accounts.find((a: DynamicRecord) => a.id === accountId);
        return canAccessAccount(currentUser, account);
    }

    // 获取当前用户可访问的账号ID列表
    const getAccessibleAccountIds = (req: Request): unknown[] => {
        const currentUser = req.currentUser;
        if (!currentUser) return [];
        // 管理员可以访问所有账号
        if (currentUser.role === 'admin') {
            const accounts = getAccountList();
            return accounts.map((a: DynamicRecord) => a.id);
        }
        // 普通用户只能访问自己的账号
        const accounts = getAccountList(currentUser.username);
        return accounts.map((a: DynamicRecord) => a.id);
    };

    // 根据用户对象获取可访问的账号ID列表（用于WebSocket）
    const getAccessibleAccountIdsForUser = (user: DynamicRecord | undefined): unknown[] => {
        if (!user) return [];
        // 管理员可以访问所有账号
        if (user.role === 'admin') {
            const accounts = getAccountList();
            return accounts.map((a: DynamicRecord) => a.id);
        }
        // 普通用户只能访问自己的账号
        const accounts = getAccountList(user.username);
        return accounts.map((a: DynamicRecord) => a.id);
    };

    function handleApiError(res: Response, err: unknown) {
        if (isSoftRuntimeError(err)) {
            return res.json({ ok: false, error: errorMessage(err) });
        }
        return res.status(500).json({ ok: false, error: errorMessage(err) });
    }

    function resolveAccId(rawRef: unknown): string {
        const input = normalizeAccountRef(rawRef);
        if (!input) return '';

        if (provider && typeof provider.resolveAccountId === 'function') {
            const resolvedByProvider = normalizeAccountRef(provider.resolveAccountId(input));
            if (resolvedByProvider) return resolvedByProvider;
        }

        const resolved = resolveAccountId(getAccountList(), input);
        return resolved || input;
    }

    // Helper to get account ID from header
    function getAccId(req: Request): string {
        return resolveAccId(req.headers['x-account-id']);
    }

    registerGameplayRoutes({
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
    });

    registerConfigRoutes({
        adminRequired,
        app,
        authRequired,
        checkAccountAccess,
        getAccountId: getAccId,
        getDefaultSystemConfig,
        getRuntimeConfig,
        provider,
        store,
        updateRuntimeConfig,
        versionChecker,
    });

    registerUserRoutes({
        adminRequired,
        app,
        authRequired,
        disconnectTokenSockets,
        store,
        tokens,
        tokenUserMap,
        userStore,
    });

    registerAccountRoutes({
        addOrUpdateAccount,
        app,
        checkAccountAccess,
        deleteAccount,
        findAccountByRef,
        getAccessibleAccountIds,
        getAccountList,
        provider,
        resolveAccountId: resolveAccId,
        userStore,
        wxLoginAdapter,
    });

    registerLogRoutes({
        app,
        checkAccountAccess,
        getAccessibleAccountIds,
        getAccountId: getAccId,
        getSocketServer: () => io,
        handleApiError,
        provider,
        resolveAccountId: resolveAccId,
    });
    registerQrRoutes(app);

    const port = CONFIG.adminPort || 3007;
    server = app.listen(port, '0.0.0.0', () => {
        adminLogger.info('admin panel started', { url: `http://localhost:${port}`, port });
    });

    io = createAdminSocket({
        canAccessAccount,
        getAccessibleAccountIdsForUser,
        getAccountList,
        provider,
        resolveAccountId: resolveAccId,
        server,
        tokens,
        tokenUserMap,
    });

    registerActivityRoutes({ app, provider, getAccountId: getAccId, canAccessAccount: checkAccountAccess });

    // SPA 兜底必须最后注册，避免拦截 API 路由。
    registerSpaFallback({ app, webDist });
}

export {
    emitRealtimeAccountLog,
    emitRealtimeLog,
    emitRealtimeStatus,
    startAdminServer,
};
