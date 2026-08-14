import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import type { Logger } from 'winston';
import { ensureDataDir } from '../config/runtime-paths';

type SanitizedValue = string | number | boolean | null | undefined | SanitizedValue[] | {
    [key: string]: SanitizedValue;
};

export interface ModuleLogger {
    info: (message: unknown, meta?: unknown) => void;
    warn: (message: unknown, meta?: unknown) => void;
    error: (message: unknown, meta?: unknown) => void;
    debug: (message: unknown, meta?: unknown) => void;
}

let winston: typeof import('winston') | null = null;
try {
    // 可选依赖：未安装时回退到 console，避免运行中断
    winston = require('winston') as typeof import('winston');
} catch {
    winston = null;
}

const SENSITIVE_KEY_RE = /code|token|password|passwd|auth|ticket|cookie|session/i;

export function redactString(input: unknown): string {
    let text = String(input || '');
    text = text.replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]');
    text = text.replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]');
    return text;
}

export function sanitizeMeta(value: unknown, depth = 0): SanitizedValue {
    if (depth > 4) return '[Truncated]';
    if (value === null || value === undefined) return value as null | undefined;
    if (typeof value === 'string') return redactString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value)) return value.map(item => sanitizeMeta(item, depth + 1));

    const out: Record<string, SanitizedValue> = {};
    for (const [key, item] of Object.entries(value)) {
        if (SENSITIVE_KEY_RE.test(String(key))) {
            out[key] = '[REDACTED]';
        } else {
            out[key] = sanitizeMeta(item, depth + 1);
        }
    }
    return out;
}

function hasMeta(value: SanitizedValue): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value !== 'object') return String(value).length > 0;
    return Object.keys(value).length > 0;
}

let fallbackLogDir: string | null = null;

function ensureFallbackLogDir(): string {
    if (fallbackLogDir) return fallbackLogDir;
    const dataDir = ensureDataDir();
    const dir = path.join(dataDir, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fallbackLogDir = dir;
    return fallbackLogDir;
}

function appendFallbackLog(level: string, moduleName: string, message: unknown, meta: unknown): void {
    try {
        const dir = ensureFallbackLogDir();
        const payload = {
            ts: new Date().toISOString(),
            level,
            module: moduleName,
            message: redactString(message),
            meta: sanitizeMeta(meta || {}),
        };
        const line = `${JSON.stringify(payload)}\n`;
        fs.appendFileSync(path.join(dir, 'combined.log'), line, 'utf8');
        if (level === 'error') {
            fs.appendFileSync(path.join(dir, 'error.log'), line, 'utf8');
        }
    } catch {
        // ignore file write errors in fallback mode
    }
}

function createConsoleFallback(moduleName: string): ModuleLogger {
    const write = (level: string, message: unknown, meta: unknown) => {
        const ts = new Date().toISOString();
        const safeMsg = redactString(message);
        const safeMeta = sanitizeMeta(meta);
        appendFallbackLog(level, moduleName, safeMsg, safeMeta);
        if (hasMeta(safeMeta)) {
            console.warn(`[${ts}] [${level}] [${moduleName}] ${safeMsg} ${JSON.stringify(safeMeta)}`);
        } else {
            console.warn(`[${ts}] [${level}] [${moduleName}] ${safeMsg}`);
        }
    };
    return {
        info: (message, meta) => write('info', message, meta),
        warn: (message, meta) => write('warn', message, meta),
        error: (message, meta) => write('error', message, meta),
        debug: (message, meta) => write('debug', message, meta),
    };
}

let rootLogger: Logger | null = null;

function getRootLogger(): Logger | null {
    if (rootLogger) return rootLogger;

    if (!winston) {
        rootLogger = null;
        return rootLogger;
    }

    const dataDir = ensureDataDir();
    const logDir = path.join(dataDir, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const level = String(process.env.LOG_LEVEL || 'info').toLowerCase();
    const { combine, timestamp, errors, json, colorize, printf } = winston.format;

    rootLogger = winston.createLogger({
        level,
        defaultMeta: { app: 'qq-farm-bot' },
        transports: [
            new winston.transports.Console({
                format: combine(
                    colorize(),
                    timestamp(),
                    errors({ stack: true }),
                    printf((info) => {
                        const moduleName = info.module ? `[${String(info.module)}] ` : '';
                        const msg = redactString(info.message || '');
                        const meta = { ...info } as Partial<Record<string, unknown>>;
                        delete meta.level;
                        delete meta.message;
                        delete meta.timestamp;
                        delete meta.app;
                        delete meta.module;
                        const safeMeta = sanitizeMeta(meta);
                        return `${String(info.timestamp)} [${String(info.level)}] ${moduleName}${msg}${hasMeta(safeMeta) ? ` ${JSON.stringify(safeMeta)}` : ''}`;
                    }),
                ),
            }),
            new winston.transports.File({
                filename: path.join(logDir, 'combined.log'),
                format: combine(timestamp(), errors({ stack: true }), json()),
            }),
            new winston.transports.File({
                filename: path.join(logDir, 'error.log'),
                level: 'error',
                format: combine(timestamp(), errors({ stack: true }), json()),
            }),
        ],
    });

    return rootLogger;
}

export function createModuleLogger(moduleName = 'app'): ModuleLogger {
    const moduleTag = String(moduleName || 'app');
    const root = getRootLogger();
    if (!root) return createConsoleFallback(moduleTag);

    const child = root.child({ module: moduleTag });
    return {
        info(message, meta = {}) {
            child.info(redactString(message), sanitizeMeta(meta));
        },
        warn(message, meta = {}) {
            child.warn(redactString(message), sanitizeMeta(meta));
        },
        error(message, meta = {}) {
            child.error(redactString(message), sanitizeMeta(meta));
        },
        debug(message, meta = {}) {
            child.debug(redactString(message), sanitizeMeta(meta));
        },
    };
}
