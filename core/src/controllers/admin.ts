/**
 * 管理面板 HTTP 服务
 * 改写为接收 DataProvider 模式
 */

import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { Express, Request, Response } from 'express';
import express from 'express';
import type { Socket, Server as SocketServer } from 'socket.io';
import { Server as SocketIOServer } from 'socket.io';
import type { DataProvider } from '../runtime/data-provider';
import { registerAccountRoutes } from './admin-routes/accounts';
import { registerActivityRoutes } from './admin-routes/activity';
import { registerAuthRoutes } from './admin-routes/auth-routes';
import { createAdminAuth } from './admin-routes/auth';
import { registerConfigRoutes } from './admin-routes/config';
import { registerSpaFallback, registerStaticResourceRoutes } from './admin-routes/resources';
import { registerRuntimeRoutes } from './admin-routes/runtime';
const { getCorePackagePath, getWebDistPath } = require('../config/runtime-paths');
const { version } = JSON.parse(fs.readFileSync(getCorePackagePath(), 'utf8'));
const { CONFIG, updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig } = require('../config/config');
const { getLevelExpProgress } = require('../config/gameConfig');
const { getBundleRoot } = require('../game-data/resource-bundle');
const store = require('../models/store');
const { addOrUpdateAccount, deleteAccount } = store;
const { findAccountByRef, normalizeAccountRef, resolveAccountId } = require('../services/account-resolver');
const { canAccessAccount, filterLogsByAccountIds } = require('../services/access-policy');
const { createModuleLogger } = require('../services/logger');
const { MiniProgramLoginSession } = require('../services/qrlogin');
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

    // API: 好友列表
    app.get('/api/friends', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const forceSync = req.query.forceSync === 'true';

        try {
            const data = await provider.getFriends(id, forceSync);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // 清除好友列表缓存
    app.post('/api/friends/clear-cache', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            await provider.clearFriendsCache(id);
            res.json({ ok: true });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // 访客
    app.get('/api/interact-records', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = await provider.getInteractRecords(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });
    // API: 好友农田详情
    app.get('/api/friend/:gid/lands', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.getFriendLands(id, req.params.gid);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 对指定好友执行单次操作（偷菜/浇水/除草/捣乱）
    app.post('/api/friend/:gid/op', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const opType = String((req.body || {}).opType || '');
            const data = await provider.doFriendOp(id, req.params.gid, opType);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 好友黑名单
    app.get('/api/friend-blacklist', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const gids = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
        
        // 尝试获取好友列表以附加昵称和头像
        let friendsList = [];
        try {
            if (provider && typeof provider.getFriends === 'function') {
                friendsList = await provider.getFriends(id) || [];
            }
        } catch {
            // 忽略获取好友列表失败
        }
        
        // 构建好友信息映射
        const friendMap = new Map();
        for (const f of friendsList) {
            const gid = Number(f && f.gid);
            if (gid > 0) {
                friendMap.set(gid, {
                    name: f.name || f.remark || '',
                    avatarUrl: f.avatarUrl || f.avatar_url || '',
                });
            }
        }
        
        // 构建带好友信息的黑名单
        const list = gids.map((gid: unknown) => {
            const info = friendMap.get(Number(gid)) || {};
            return {
                gid: Number(gid),
                name: info.name || '',
                avatarUrl: info.avatarUrl || '',
            };
        });
        
        res.json({ ok: true, data: list });
    });

    app.post('/api/friend-blacklist/toggle', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const gid = Number((req.body || {}).gid);
        if (!gid) return res.status(400).json({ ok: false, error: 'Missing gid' });
        const current = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
        let next;
        if (current.includes(gid)) {
            next = current.filter((g: unknown) => g !== gid);
        } else {
            next = [...current, gid];
        }
        const savedGids = store.setFriendBlacklist ? store.setFriendBlacklist(id, next) : next;
        
        // 同步配置到 worker 进程
        if (provider && typeof provider.broadcastConfig === 'function') {
            provider.broadcastConfig(id);
        }
        
        // 尝试获取好友列表以附加昵称和头像
        let friendsList = [];
        try {
            if (provider && typeof provider.getFriends === 'function') {
                friendsList = await provider.getFriends(id) || [];
            }
        } catch {
            // 忽略获取好友列表失败
        }
        
        // 构建好友信息映射
        const friendMap = new Map();
        for (const f of friendsList) {
            const fGid = Number(f && f.gid);
            if (fGid > 0) {
                friendMap.set(fGid, {
                    name: f.name || f.remark || '',
                    avatarUrl: f.avatarUrl || f.avatar_url || '',
                });
            }
        }
        
        // 构建带好友信息的黑名单
        const saved = savedGids.map((g: unknown) => {
            const info = friendMap.get(Number(g)) || {};
            return {
                gid: Number(g),
                name: info.name || '',
                avatarUrl: info.avatarUrl || '',
            };
        });
        
        res.json({ ok: true, data: saved });
    });

    // ============ 好友GID管理 API ============
    function buildKnownFriendGidSettings(accountId: string) {
        return {
            knownFriendGids: store.getKnownFriendGids ? store.getKnownFriendGids(accountId) : [],
            knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec
                ? store.getKnownFriendGidSyncCooldownSec(accountId)
                : 600,
            friendsListCacheTtlSec: store.getFriendsListCacheTtlSec
                ? store.getFriendsListCacheTtlSec(accountId)
                : 60,
        };
    }

    // 获取已知好友GID设置
    app.get('/api/friend-known-gids', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // 保存已知好友GID设置
    app.post('/api/friend-known-gids', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            if (body.knownFriendGids !== undefined && store.setKnownFriendGids) {
                store.setKnownFriendGids(id, body.knownFriendGids);
            }
            if (body.knownFriendGidSyncCooldownSec !== undefined && store.setKnownFriendGidSyncCooldownSec) {
                store.setKnownFriendGidSyncCooldownSec(id, body.knownFriendGidSyncCooldownSec);
            }
            if (body.friendsListCacheTtlSec !== undefined && store.setFriendsListCacheTtlSec) {
                store.setFriendsListCacheTtlSec(id, body.friendsListCacheTtlSec);
            }
            // 同步配置到 worker 进程
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // 移除单个好友GID
    app.post('/api/friend-known-gids/remove', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const gid = Number((req.body || {}).gid);
        if (!Number.isFinite(gid) || gid <= 0) {
            return res.status(400).json({ ok: false, error: 'GID 无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const next = Array.isArray(current) ? current.filter(item => Number(item) !== gid) : [];
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            // 同步配置到 worker 进程
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // 批量添加好友GID
    app.post('/api/friend-known-gids/batch-add', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const gids = (req.body || {}).gids;
        if (!Array.isArray(gids) || gids.length === 0) {
            return res.status(400).json({ ok: false, error: 'GID 列表无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const currentSet = new Set(current.map(Number));
            let addedCount = 0;
            for (const gid of gids) {
                const num = Number(gid);
                if (!Number.isFinite(num) || num <= 0) continue;
                if (!currentSet.has(num)) {
                    currentSet.add(num);
                    addedCount++;
                }
            }
            const next = Array.from(currentSet);
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            // 同步配置到 worker 进程
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(id);
            }
            return res.json({ 
                ok: true, 
                data: buildKnownFriendGidSettings(id),
                addedCount,
            });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // 批量删除未同步的好友GID
    app.post('/api/friend-known-gids/batch-remove', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const gids = (req.body || {}).gids;
        if (!Array.isArray(gids) || gids.length === 0) {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id), removedCount: 0 });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const removeSet = new Set(gids.map(Number).filter(n => Number.isFinite(n) && n > 0));
            const next = current.filter((gid: unknown) => !removeSet.has(Number(gid)));
            const removedCount = current.length - next.length;

            if (removedCount > 0 && store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }

            return res.json({ 
                ok: true, 
                data: buildKnownFriendGidSettings(id),
                removedCount,
            });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // API: 蔬菜黑名单
    app.get('/api/plant-blacklist', authRequired, (req, res) => {
        try {
            const accountId = getAccId(req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const list = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: list });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.post('/api/plant-blacklist', authRequired, (req, res) => {
        try {
            const accountId = getAccId(req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const seedId = Number((req.body || {}).seedId);
            if (!seedId) return res.status(400).json({ ok: false, error: 'Missing seedId' });

            const current = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];

            if (!current.includes(seedId)) {
                const next = [...current, seedId];
                if (store.setPlantBlacklist) {
                    store.setPlantBlacklist(accountId, next);
                }
            }

            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(accountId);
            }

            const saved = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: saved });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/plant-blacklist/:seedId', authRequired, (req, res) => {
        try {
            const accountId = getAccId(req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const seedId = Number(req.params.seedId);
            if (!seedId) return res.status(400).json({ ok: false, error: 'Missing seedId' });

            const current = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            const next = current.filter((id: unknown) => id !== seedId);

            if (store.setPlantBlacklist) {
                store.setPlantBlacklist(accountId, next);
            }

            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(accountId);
            }

            const saved = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: saved });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 批量添加蔬菜黑名单
    app.post('/api/plant-blacklist/batch', authRequired, (req, res) => {
        try {
            const accountId = getAccId(req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const seedIds = (req.body || {}).seedIds || [];
            if (!Array.isArray(seedIds)) {
                return res.status(400).json({ ok: false, error: 'seedIds must be an array' });
            }

            const current = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            const merged = [...new Set([...current, ...seedIds.map(Number).filter(n => Number.isFinite(n) && n > 0)])];

            if (store.setPlantBlacklist) {
                store.setPlantBlacklist(accountId, merged);
            }

            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(accountId);
            }

            const saved = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: saved });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 清空蔬菜黑名单
    app.delete('/api/plant-blacklist', authRequired, (req, res) => {
        try {
            const accountId = getAccId(req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            if (store.setPlantBlacklist) {
                store.setPlantBlacklist(accountId, []);
            }

            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(accountId);
            }

            res.json({ ok: true, data: [] });
        } catch (e) {
            handleApiError(res, e);
        }
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
            const { itemId, count } = req.body;
            if (!itemId) return res.status(400).json({ ok: false, error: '缺少 itemId' });
            const data = await provider.useItem(id, Number(itemId), Math.max(1, Number(count) || 1));
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

            // 微信账号：启动前自动刷新登录 code（wx.login code 短时效）——不阻塞启动响应：
            // MMTLS 握手可能耗时 6s+（微信服务器目标逐个超时），await 会让前端"点击登录"卡住；
            // 即使刷新失败/未完成，worker 用旧 code 启动后由 ws_code_rejected 自动刷新链路兜底（loginBuffer 已持久化）
            try {
                const account = provider.getAccounts().accounts.find((a: DynamicRecord) => String(a.id) === String(accountId));
                if (account && account.platform === 'wx' && account.wxid) {
                    wxLoginAdapter.getFarmCode(account.wxid, { accountId })
                        .then((refresh: DynamicRecord) => {
                            if (refresh.Success && refresh.Data && refresh.Data.code) {
                                addOrUpdateAccount({ id: accountId, code: refresh.Data.code });
                                adminLogger.info('startAccount', { accountId, note: 'wx code refreshed automatically' });
                            } else {
                                adminLogger.warn('startAccount', { accountId, note: 'wx code refresh failed, fallback to stored code', msg: refresh.Message });
                            }
                        })
                        .catch((refreshErr: unknown) => {
                            adminLogger.warn('startAccount', { accountId, note: 'wx code refresh error, fallback to stored code', err: errorMessage(refreshErr) });
                        });
                }
            } catch (refreshErr) {
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
                    if (io) {
                        for (const socket of io.sockets.sockets.values()) {
                            if (String(socket.data.adminToken || '') === String(token)) {
                                socket.disconnect(true);
                            }
                        }
                    }
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

    // ============ QR Code Login APIs (无需账号选择) ============
    // 这些接口不需要 authRequired 也能调用（用于登录流程）
    app.post('/api/qr/create', async (req, res) => {
        try {
            const result = await MiniProgramLoginSession.requestLoginCode();
            res.json({ ok: true, data: result });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    app.post('/api/qr/check', async (req, res) => {
        const { code } = req.body || {};
        if (!code) {
            return res.status(400).json({ ok: false, error: 'Missing code' });
        }

        try {
            const result = await MiniProgramLoginSession.queryStatus(code);

            if (result.status === 'OK') {
                const ticket = result.ticket;
                const uin = result.uin || '';
                const nickname = result.nickname || ''; // 获取昵称
                const appid = '1112386029'; // Farm appid

                const authCode = await MiniProgramLoginSession.getAuthCode(ticket, appid);

                let avatar = '';
                if (uin) {
                    avatar = `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640`;
                }

                res.json({ ok: true, data: { status: 'OK', code: authCode, uin, avatar, nickname } });
            } else if (result.status === 'Used') {
                res.json({ ok: true, data: { status: 'Used' } });
            } else if (result.status === 'Wait') {
                res.json({ ok: true, data: { status: 'Wait' } });
            } else {
                res.json({ ok: true, data: { status: 'Error', error: result.msg } });
            }
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    const applySocketSubscription = (socket: Socket, accountRef: unknown = ''): void => {
        const incoming = String(accountRef || '').trim();
        const resolved = incoming && incoming !== 'all' ? resolveAccId(incoming) : '';

        // 获取当前用户信息
        const token = socket.data.adminToken;
        const currentUser = token ? tokenUserMap.get(token) : null;

        // 检查权限：如果指定了账号ID，检查用户是否有权访问
        if (resolved && currentUser) {
            const accounts = getAccountList();
            const account = accounts.find((a: DynamicRecord) => a.id === resolved);
            if (!canAccessAccount(currentUser, account)) {
                // 无权访问，拒绝订阅
                socket.emit('subscribed', { accountId: 'all', error: '无权访问此账号' });
                // 只订阅all频道（空数据）
                for (const room of socket.rooms) {
                    if (room.startsWith('account:')) socket.leave(room);
                }
                socket.join('account:all');
                socket.data.accountId = '';
                return;
            }
        }

        for (const room of socket.rooms) {
            if (room.startsWith('account:')) socket.leave(room);
        }
        if (resolved) {
            socket.join(`account:${resolved}`);
            socket.data.accountId = resolved;
        } else {
            socket.join('account:all');
            socket.data.accountId = '';
        }
        socket.emit('subscribed', { accountId: socket.data.accountId || 'all' });

        try {
            const targetId = socket.data.accountId || '';
            const user = socket.data.user;

            if (targetId && provider && typeof provider.getStatus === 'function') {
                const currentStatus = provider.getStatus(targetId);
                socket.emit('status:update', { accountId: targetId, status: currentStatus });
            }
            if (provider && typeof provider.getLogs === 'function') {
                let currentLogs = provider.getLogs(targetId, { limit: 100 });
                if (!Array.isArray(currentLogs)) currentLogs = [];

                // 过滤日志：只返回用户有权限访问的账号的日志
                if (user) {
                    const accessibleIds = getAccessibleAccountIdsForUser(user);
                    currentLogs = filterLogsByAccountIds(currentLogs, accessibleIds, true);
                }

                socket.emit('logs:snapshot', {
                    accountId: targetId || 'all',
                    logs: currentLogs,
                });
            }
            if (provider && typeof provider.getAccountLogs === 'function') {
                let currentAccountLogs = provider.getAccountLogs(100);
                if (!Array.isArray(currentAccountLogs)) currentAccountLogs = [];

                // 过滤账号操作日志：只返回用户有权限访问的账号的日志
                if (user) {
                    const accessibleIds = getAccessibleAccountIdsForUser(user);
                    currentAccountLogs = filterLogsByAccountIds(currentAccountLogs, accessibleIds);
                }

                socket.emit('account-logs:snapshot', {
                    logs: currentAccountLogs,
                });
            }
        } catch {
            // ignore snapshot push errors
        }
    };

    const port = CONFIG.adminPort || 3007;
    server = app.listen(port, '0.0.0.0', () => {
        adminLogger.info('admin panel started', { url: `http://localhost:${port}`, port });
    });

    io = new SocketIOServer(server, {
        path: '/socket.io',
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            allowedHeaders: ['x-admin-token', 'x-account-id'],
        },
    });

    io.use((socket, next) => {
        const authToken = socket.handshake.auth && socket.handshake.auth.token
            ? String(socket.handshake.auth.token)
            : '';
        const headerToken = socket.handshake.headers && socket.handshake.headers['x-admin-token']
            ? String(socket.handshake.headers['x-admin-token'])
            : '';
        const token = authToken || headerToken;
        if (!token || !tokens.has(token)) {
            return next(new Error('Unauthorized'));
        }
        socket.data.adminToken = token;
        // 存储用户信息到socket
        socket.data.user = tokenUserMap.get(token);
        return next();
    });

    io.on('connection', (socket) => {
        const initialAccountRef = (socket.handshake.auth && socket.handshake.auth.accountId)
            || (socket.handshake.query && socket.handshake.query.accountId)
            || '';
        applySocketSubscription(socket, initialAccountRef);
        socket.emit('ready', { ok: true, ts: Date.now() });

        socket.on('subscribe', (payload) => {
            const body = (payload && typeof payload === 'object') ? payload : {};
            applySocketSubscription(socket, body.accountId || '');
        });
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
