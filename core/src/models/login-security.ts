import { ensureDataDir, getDataFile } from '../config/runtime-paths';
import { readJsonFile, writeJsonFileAtomic } from '../services/json-db';

interface LoginAttempt {
    count: number;
    windowStart?: number;
    firstAttempt?: number;
    lastAttempt?: number;
    lockedUntil?: number;
}

type LoginAttempts = Record<string, LoginAttempt>;
export type LoginLogEntry = Record<string, unknown> & { id: string; timestamp: number };

export interface LoginSecurityDependencies {
    ensureDataDir: () => string;
    getDataFile: (filename: string) => string;
    readJsonFile: typeof readJsonFile;
    writeJsonFileAtomic: typeof writeJsonFileAtomic;
    now?: () => number;
    random?: () => number;
}

export interface LoginSecurityService {
    loadLoginAttempts: () => void;
    checkRateLimit: (ip: unknown) => Record<string, unknown> & { allowed: boolean };
    checkAccountLockout: (username: unknown) => Record<string, unknown> & { locked: boolean };
    recordFailedAttempt: (username: unknown) => Record<string, unknown> & { locked: boolean };
    clearFailedAttempts: (username: unknown) => void;
    addLoginLog: (entry: Record<string, unknown>) => LoginLogEntry;
    getLoginLogs: (limit?: number, offset?: number) => { logs: LoginLogEntry[]; total: number };
    clearLoginLogs: () => { ok: true };
}

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000;
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_ATTEMPTS_PER_IP = 10;

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function normalizeLoginAttempts(value: unknown): LoginAttempts {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: LoginAttempts = {};
    for (const [key, item] of Object.entries(value)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const source = item as Record<string, unknown>;
        const count = Number(source.count);
        if (!Number.isFinite(count) || count < 0) continue;
        result[key] = {
            count,
            ...(Number.isFinite(Number(source.windowStart)) ? { windowStart: Number(source.windowStart) } : {}),
            ...(Number.isFinite(Number(source.firstAttempt)) ? { firstAttempt: Number(source.firstAttempt) } : {}),
            ...(Number.isFinite(Number(source.lastAttempt)) ? { lastAttempt: Number(source.lastAttempt) } : {}),
            ...(Number.isFinite(Number(source.lockedUntil)) ? { lockedUntil: Number(source.lockedUntil) } : {}),
        };
    }
    return result;
}

function normalizeLoginLogs(value: unknown): LoginLogEntry[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is LoginLogEntry => Boolean(
        item
        && typeof item === 'object'
        && !Array.isArray(item)
        && typeof item.id === 'string'
        && Number.isFinite(Number(item.timestamp)),
    ));
}

export function createLoginSecurityService(
    dependencies: LoginSecurityDependencies = {
        ensureDataDir,
        getDataFile,
        readJsonFile,
        writeJsonFileAtomic,
    },
): LoginSecurityService {
    const attemptsFile = dependencies.getDataFile('login-attempts.json');
    const logsFile = dependencies.getDataFile('login-logs.json');
    const now = dependencies.now || Date.now;
    const random = dependencies.random || Math.random;
    let loginAttempts: LoginAttempts = {};
    let loginLogs: LoginLogEntry[] = [];

    const saveLoginAttempts = () => {
        try {
            dependencies.ensureDataDir();
            dependencies.writeJsonFileAtomic(attemptsFile, loginAttempts);
        } catch (error) {
            console.error('保存登录尝试记录失败:', errorMessage(error));
        }
    };

    const loadLoginAttempts = () => {
        try {
            dependencies.ensureDataDir();
            loginAttempts = normalizeLoginAttempts(dependencies.readJsonFile<unknown>(attemptsFile, () => ({})));
        } catch {
            loginAttempts = {};
        }
    };

    const cleanExpiredAttempts = () => {
        const currentTime = now();
        let cleaned = false;
        for (const key of Object.keys(loginAttempts)) {
            const attempt = loginAttempts[key];
            if (attempt.lockedUntil && attempt.lockedUntil < currentTime) {
                delete loginAttempts[key];
                cleaned = true;
            } else if (attempt.windowStart && currentTime - attempt.windowStart > RATE_LIMIT_WINDOW) {
                delete loginAttempts[key];
                cleaned = true;
            }
        }
        if (cleaned) saveLoginAttempts();
    };

    const checkRateLimit = (ip: unknown) => {
        cleanExpiredAttempts();
        const ipKey = `ip:${String(ip)}`;
        const currentTime = now();
        const existing = loginAttempts[ipKey];
        if (!existing || !existing.windowStart) {
            loginAttempts[ipKey] = { count: 1, windowStart: currentTime };
            saveLoginAttempts();
            return { allowed: true };
        }
        if (currentTime - existing.windowStart > RATE_LIMIT_WINDOW) {
            loginAttempts[ipKey] = { count: 1, windowStart: currentTime };
            saveLoginAttempts();
            return { allowed: true };
        }
        if (existing.count >= MAX_ATTEMPTS_PER_IP) {
            const remainingMs = RATE_LIMIT_WINDOW - (currentTime - existing.windowStart);
            return {
                allowed: false,
                remainingMs,
                message: `请求过于频繁，请 ${Math.ceil(remainingMs / 1000)} 秒后重试`,
            };
        }
        existing.count += 1;
        saveLoginAttempts();
        return { allowed: true };
    };

    const checkAccountLockout = (username: unknown) => {
        cleanExpiredAttempts();
        const userKey = `user:${String(username)}`;
        const currentTime = now();
        const attempt = loginAttempts[userKey];
        if (attempt?.lockedUntil) {
            if (attempt.lockedUntil > currentTime) {
                const remainingMs = attempt.lockedUntil - currentTime;
                return {
                    locked: true,
                    remainingMs,
                    message: `账户已被锁定，请 ${Math.ceil(remainingMs / 1000 / 60)} 分钟后重试`,
                };
            }
            delete loginAttempts[userKey];
            saveLoginAttempts();
        }
        return { locked: false };
    };

    const recordFailedAttempt = (username: unknown) => {
        const userKey = `user:${String(username)}`;
        const currentTime = now();
        const existing = loginAttempts[userKey];
        if (!existing) {
            loginAttempts[userKey] = { count: 1, firstAttempt: currentTime };
        } else {
            existing.count += 1;
            existing.lastAttempt = currentTime;
        }
        const attempt = loginAttempts[userKey];
        if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
            attempt.lockedUntil = currentTime + LOCKOUT_DURATION;
            saveLoginAttempts();
            return {
                locked: true,
                message: `登录失败次数过多，账户已被锁定 ${LOCKOUT_DURATION / 60000} 分钟`,
            };
        }
        saveLoginAttempts();
        return { locked: false, remainingAttempts: MAX_LOGIN_ATTEMPTS - attempt.count };
    };

    const clearFailedAttempts = (username: unknown) => {
        const userKey = `user:${String(username)}`;
        if (loginAttempts[userKey]) {
            delete loginAttempts[userKey];
            saveLoginAttempts();
        }
    };

    const loadLoginLogs = () => {
        try {
            dependencies.ensureDataDir();
            const data = dependencies.readJsonFile<{ logs?: unknown }>(logsFile, () => ({ logs: [] }));
            loginLogs = normalizeLoginLogs(data.logs);
        } catch {
            loginLogs = [];
        }
    };

    const saveLoginLogs = () => {
        try {
            dependencies.ensureDataDir();
            dependencies.writeJsonFileAtomic(logsFile, { logs: loginLogs.slice(-1000) });
        } catch (error) {
            console.error('保存登录日志失败:', errorMessage(error));
        }
    };

    const addLoginLog = (entry: Record<string, unknown>) => {
        loadLoginLogs();
        const timestamp = now();
        const logEntry: LoginLogEntry = {
            id: `${timestamp}${random().toString(36).slice(2, 11)}`,
            timestamp,
            ...entry,
        };
        loginLogs.push(logEntry);
        if (loginLogs.length > 1000) loginLogs = loginLogs.slice(-1000);
        saveLoginLogs();
        return logEntry;
    };

    const getLoginLogs = (limit = 100, offset = 0) => {
        loadLoginLogs();
        const sorted = [...loginLogs].sort((left, right) => right.timestamp - left.timestamp);
        return { logs: sorted.slice(offset, offset + limit), total: loginLogs.length };
    };

    const clearLoginLogs = () => {
        loginLogs = [];
        saveLoginLogs();
        return { ok: true as const };
    };

    return {
        loadLoginAttempts,
        checkRateLimit,
        checkAccountLockout,
        recordFailedAttempt,
        clearFailedAttempts,
        addLoginLog,
        getLoginLogs,
        clearLoginLogs,
    };
}
