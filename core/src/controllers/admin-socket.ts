import type { Server as HttpServer } from 'node:http';
import type { Socket, Server as SocketServer } from 'socket.io';
import { Server as SocketIOServer } from 'socket.io';
import type { DataProvider } from '../runtime/data-provider';

const { filterLogsByAccountIds } = require('../services/access-policy');

type DynamicRecord = Record<string, any>;

interface AdminSocketOptions {
    canAccessAccount: (user: DynamicRecord, account: DynamicRecord | undefined) => boolean;
    getAccessibleAccountIdsForUser: (user: DynamicRecord | undefined) => unknown[];
    getAccountList: (username?: string | null) => DynamicRecord[];
    provider: DataProvider;
    resolveAccountId: (accountRef: unknown) => string;
    server: HttpServer;
    tokens: Set<string>;
    tokenUserMap: Map<string, DynamicRecord>;
}

interface SocketSubscriptionTarget {
    accountId: string;
    error?: string;
}

function resolveSocketIdentity(
    handshake: DynamicRecord,
    tokens: Set<string>,
    tokenUserMap: Map<string, DynamicRecord>,
): { token: string; user: DynamicRecord } | null {
    const authToken = handshake.auth?.token ? String(handshake.auth.token) : '';
    const headerToken = handshake.headers?.['x-admin-token']
        ? String(handshake.headers['x-admin-token'])
        : '';
    const token = authToken || headerToken;
    const user = token ? tokenUserMap.get(token) : null;
    if (!token || !tokens.has(token) || !user) return null;
    return { token, user };
}

function resolveSocketSubscriptionTarget(
    accountRef: unknown,
    currentUser: DynamicRecord | null | undefined,
    getAccounts: () => DynamicRecord[],
    resolveAccountId: (accountRef: unknown) => string,
    canAccessAccount: (user: DynamicRecord, account: DynamicRecord | undefined) => boolean,
): SocketSubscriptionTarget {
    const incoming = String(accountRef || '').trim();
    const accountId = incoming && incoming !== 'all' ? resolveAccountId(incoming) : '';
    if (!currentUser) return { accountId: '', error: 'Unauthorized' };
    if (accountId) {
        const account = getAccounts().find(item => item.id === accountId);
        if (!canAccessAccount(currentUser, account)) {
            return { accountId: '', error: '无权访问此账号' };
        }
    }
    return { accountId };
}

function replaceSocketAccountRoom(socket: Socket, accountId: string): void {
    for (const room of socket.rooms) {
        if (room.startsWith('account:')) socket.leave(room);
    }
    if (accountId) {
        socket.join(`account:${accountId}`);
        socket.data.accountId = accountId;
    } else {
        socket.join('account:all');
        socket.data.accountId = '';
    }
}

function createAdminSocket(options: AdminSocketOptions): SocketServer {
    const {
        canAccessAccount,
        getAccessibleAccountIdsForUser,
        getAccountList,
        provider,
        resolveAccountId: resolveAccId,
        server,
        tokens,
        tokenUserMap,
    } = options;

    const applySocketSubscription = (socket: Socket, accountRef: unknown = ''): void => {
        const token = socket.data.adminToken;
        const currentUser = token ? tokenUserMap.get(token) : null;
        const target = resolveSocketSubscriptionTarget(
            accountRef,
            currentUser,
            getAccountList,
            resolveAccId,
            canAccessAccount,
        );
        if (target.error) {
            socket.emit('subscribed', { accountId: 'all', error: target.error });
            replaceSocketAccountRoom(socket, '');
            return;
        }
        replaceSocketAccountRoom(socket, target.accountId);
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

    const io = new SocketIOServer(server, {
        path: '/socket.io',
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            allowedHeaders: ['x-admin-token', 'x-account-id'],
        },
    });

    io.use((socket, next) => {
        const identity = resolveSocketIdentity(socket.handshake, tokens, tokenUserMap);
        if (!identity) return next(new Error('Unauthorized'));
        socket.data.adminToken = identity.token;
        // 存储用户信息到socket
        socket.data.user = identity.user;
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

    return io;
}

export {
    createAdminSocket,
    replaceSocketAccountRoom,
    resolveSocketIdentity,
    resolveSocketSubscriptionTarget,
};
