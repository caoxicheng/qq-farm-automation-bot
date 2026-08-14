/**
 * 安全模块 - 密码加密与验证
 * 使用bcrypt替代SHA256，增强密码安全性
 */

import crypto from 'node:crypto';
import { createModuleLogger } from './logger';

type HeaderValue = string | string[] | undefined;

interface HttpRequestLike {
    headers: Record<string, HeaderValue>;
    ip?: string;
    connection?: { remoteAddress?: string | null };
    socket?: { remoteAddress?: string | null };
    body?: unknown;
    path?: string;
}

interface HttpResponseLike {
    set: (name: string, value: string | number) => HttpResponseLike;
    status: (code: number) => HttpResponseLike;
    json: (body: unknown) => unknown;
}

type NextFunction = () => void;

interface LoginAttempt {
    count: number;
    firstAttempt: number;
    lockedUntil: number;
    lastAttempt?: number;
}

interface RateLimitRecord {
    count: number;
    resetAt: number;
}

export interface RateLimitOptions {
    windowMs?: number;
    maxRequests?: number;
    keyGenerator?: (request: HttpRequestLike) => string;
}

export interface PasswordStrength {
    score: number;
    valid: boolean;
    feedback: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const logger = createModuleLogger('security');

const SECURITY_CONFIG = {
    saltRounds: 12,
    minPasswordLength: 4,
    maxPasswordLength: 64,
    enablePasswordStrengthCheck: true,
    maxLoginAttempts: 5,
    lockoutDuration: 300000,
};

function firstHeader(value: HeaderValue): string {
    const candidate = Array.isArray(value) ? value[0] : value;
    return typeof candidate === 'string' ? candidate.trim() : '';
}

function getClientIp(req: HttpRequestLike): string {
    const cfIp = firstHeader(req.headers['cf-connecting-ip']);
    if (cfIp) return cfIp;
    
    const xRealIp = firstHeader(req.headers['x-real-ip']);
    if (xRealIp) return xRealIp;
    
    const xForwardedFor = firstHeader(req.headers['x-forwarded-for']);
    if (xForwardedFor) {
        const ips = xForwardedFor.split(',').map(ip => ip.trim()).filter(Boolean);
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

const loginAttempts = new Map<string, LoginAttempt>();

const useBcrypt = true;

function generateSalt(): string {
    return crypto.randomBytes(32).toString('hex');
}

async function hashPassword(password: string): Promise<string> {
    if (!useBcrypt) {
        return hashPasswordSHA256(password);
    }

    const salt = generateSalt();
    const iterations = 100000;
    const keyLength = 64;
    const digest = 'sha512';
    
    return new Promise<string>((resolve, reject) => {
        crypto.pbkdf2(password, salt, iterations, keyLength, digest, (err, derivedKey) => {
            if (err) reject(err);
            else {
                resolve(`$pbkdf2$${salt}$${iterations}$${derivedKey.toString('hex')}`);
            }
        });
    });
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
    if (!useBcrypt) {
        return verifyPasswordSHA256(password, storedHash);
    }

    if (!storedHash || !password) {
        return false;
    }

    try {
        if (storedHash.startsWith('$pbkdf2$')) {
            const parts = storedHash.split('$');
            if (parts.length !== 5) return false;
            
            const salt = parts[2];
            const iterations = Number.parseInt(parts[3], 10);
            const hash = parts[4];
            const keyLength = 64;
            const digest = 'sha512';
            
            return new Promise<boolean>((resolve) => {
                crypto.pbkdf2(password, salt, iterations, keyLength, digest, (err, derivedKey) => {
                    if (err) {
                        logger.error('PBKDF2验证失败', { error: err.message });
                        resolve(false);
                    } else {
                        resolve(derivedKey.toString('hex') === hash);
                    }
                });
            });
        }
        
        if (storedHash.length === 64) {
            return verifyPasswordSHA256(password, storedHash);
        }
        
        return false;
    } catch (error) {
        logger.error('密码验证异常', { error: errorMessage(error) });
        return false;
    }
}

function hashPasswordSHA256(password: string): string {
    return crypto.createHash('sha256')
        .update(String(password || ''))
        .digest('hex');
}

function verifyPasswordSHA256(password: string, storedHash: string): boolean {
    const hash = hashPasswordSHA256(password);
    return crypto.timingSafeEqual(
        Buffer.from(hash),
        Buffer.from(storedHash)
    );
}

function checkPasswordStrength(password: string): PasswordStrength {
    if (!SECURITY_CONFIG.enablePasswordStrengthCheck) {
        return { score: 0, valid: true, feedback: [] };
    }

    const feedback: string[] = [];
    let score = 0;

    if (!password) {
        return { score: 0, valid: false, feedback: ['密码不能为空'] };
    }

    if (password.length < SECURITY_CONFIG.minPasswordLength) {
        feedback.push(`密码长度至少${SECURITY_CONFIG.minPasswordLength}位`);
        return { score: 0, valid: false, feedback };
    }

    if (password.length >= 8) score += 1;
    if (password.length >= 12) score += 1;

    if (/[a-z]/.test(password)) score += 1;
    if (/[A-Z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[^a-z0-9]/i.test(password)) score += 1;

    const commonPasswords = [
        'password', '123456', 'qwerty', 'admin', 'letmein',
        'welcome', 'monkey', 'dragon', 'master', 'login'
    ];
    if (commonPasswords.includes(password.toLowerCase())) {
        score = 0;
        feedback.push('密码过于简单，请使用更复杂的密码');
    }

    if (score < 3) {
        feedback.push('建议使用字母、数字和特殊符号的组合');
    }

    return {
        score,
        valid: true,
        feedback: feedback.length > 0 ? feedback : ['密码强度良好']
    };
}

function recordLoginAttempts(identifier: unknown): { attemptsLeft: number } {
    const key = String(identifier || '').toLowerCase();
    const now = Date.now();
    
    const attempts = loginAttempts.get(key) || { count: 0, firstAttempt: now, lockedUntil: 0 };
    
    if (attempts.lockedUntil > now) {
        const remaining = Math.ceil((attempts.lockedUntil - now) / 1000);
        throw new Error(`账号已锁定，请${remaining}秒后重试`);
    }
    
    attempts.count += 1;
    attempts.lastAttempt = now;
    
    if (attempts.count >= SECURITY_CONFIG.maxLoginAttempts) {
        attempts.lockedUntil = now + SECURITY_CONFIG.lockoutDuration;
        logger.warn('登录尝试过多，账号已锁定', { identifier: key });
        throw new Error(`登录尝试过多，账号已锁定${SECURITY_CONFIG.lockoutDuration / 60000}分钟`);
    }
    
    loginAttempts.set(key, attempts);
    return {
        attemptsLeft: SECURITY_CONFIG.maxLoginAttempts - attempts.count
    };
}

function clearLoginAttempts(identifier: unknown): void {
    const key = String(identifier || '').toLowerCase();
    loginAttempts.delete(key);
}

function generateToken(length = 32): string {
    return crypto.randomBytes(length).toString('hex');
}

function generateSessionToken(): { token: string; expiresAt: number; createdAt: number } {
    return {
        token: generateToken(32),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
    };
}

function verifySessionToken(token: unknown, expiresAt: unknown): boolean {
    if (!token || !expiresAt) return false;
    const expiry = Number(expiresAt);
    if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
    return true;
}

function passwordHashMiddleware(req: HttpRequestLike, res: HttpResponseLike, next: NextFunction): unknown {
    const password = asRecord(req.body).password;
    
    if (typeof password === 'string' && password && String(req.path || '').includes('/api/')) {
        const strength = checkPasswordStrength(password);
        if (!strength.valid) {
            return res.status(400).json({
                ok: false,
                error: strength.feedback[0],
                feedback: strength.feedback
            });
        }
    }
    
    next();
}

const rateLimitStore = new Map<string, RateLimitRecord>();

function rateLimitMiddleware(options: RateLimitOptions = {}): (
    request: HttpRequestLike,
    response: HttpResponseLike,
    next: NextFunction,
) => unknown {
    const {
        windowMs = 60000,
        maxRequests = 100,
        keyGenerator = request => getClientIp(request),
    } = options;

    return (req: HttpRequestLike, res: HttpResponseLike, next: NextFunction): unknown => {
        const key = keyGenerator(req);
        const now = Date.now();
        
        const record = rateLimitStore.get(key) || { count: 0, resetAt: now + windowMs };
        
        if (now > record.resetAt) {
            record.count = 0;
            record.resetAt = now + windowMs;
        }
        
        record.count += 1;
        rateLimitStore.set(key, record);
        
        res.set('X-RateLimit-Limit', maxRequests);
        res.set('X-RateLimit-Remaining', Math.max(0, maxRequests - record.count));
        res.set('X-RateLimit-Reset', new Date(record.resetAt).toISOString());
        
        if (record.count > maxRequests) {
            return res.status(429).json({
                ok: false,
                error: '请求过于频繁，请稍后重试',
                retryAfter: Math.ceil((record.resetAt - now) / 1000)
            });
        }
        
        next();
    };
}

const rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore.entries()) {
        if (now > record.resetAt) {
            rateLimitStore.delete(key);
        }
    }
}, 60000);
rateLimitCleanupTimer.unref();

export {
    checkPasswordStrength,
    clearLoginAttempts,
    generateSessionToken,
    generateToken,
    getClientIp,
    hashPassword,
    passwordHashMiddleware,
    rateLimitMiddleware,
    recordLoginAttempts,
    SECURITY_CONFIG,
    verifyPassword,
    verifySessionToken,
};
