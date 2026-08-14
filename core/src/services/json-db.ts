import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

function ensureParentDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

export function readTextFile(filePath: string, fallback = ''): string {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return fallback;
    }
}

export function readJsonFile<T = Record<string, unknown>>(
    filePath: string,
    fallbackFactory: (() => T) | T = () => ({} as T),
): T {
    const fallback = typeof fallbackFactory === 'function'
        ? (fallbackFactory as () => T)()
        : (fallbackFactory || {} as T);
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw || !raw.trim()) return fallback;
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

export function writeJsonFileAtomic(filePath: string, data: unknown, space = 2): void {
    const json = JSON.stringify(data, null, space);
    writeTextFileAtomic(filePath, json);
}

export function writeTextFileAtomic(filePath: string, text: unknown = ''): void {
    ensureParentDir(filePath);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
        fs.writeFileSync(tmpPath, String(text), 'utf8');
        fs.renameSync(tmpPath, filePath);
    } finally {
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
            // ignore cleanup errors
        }
    }
}
