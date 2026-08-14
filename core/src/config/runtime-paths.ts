import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

const runtimeProcess = process as NodeJS.Process & { pkg?: unknown };

export const isPackaged = Boolean(runtimeProcess.pkg);

export function getCoreRoot(): string {
    const candidate = path.resolve(__dirname, '../..');
    if (path.basename(candidate) === 'build') {
        return path.resolve(candidate, '..');
    }
    return candidate;
}

function getResourceRoot(): string {
    return path.join(getCoreRoot(), 'src');
}

export function getResourcePath(...segments: string[]): string {
    return path.join(getResourceRoot(), ...segments);
}

function getAppRootForWritable(): string {
    return isPackaged ? path.dirname(runtimeProcess.execPath) : getCoreRoot();
}

export function getDataDir(): string {
    return path.join(getAppRootForWritable(), 'data');
}

export function ensureDataDir(): string {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function getDataFile(filename: string): string {
    return path.join(getDataDir(), filename);
}

export function getShareFilePath(): string {
    return path.join(getAppRootForWritable(), 'share.txt');
}

export function getWebDistPath(): string {
    return path.join(getCoreRoot(), '..', 'web', 'dist');
}

export function getGameDataRoot(): string {
    return path.join(getCoreRoot(), 'resources', 'game-data');
}

export function getCorePackagePath(): string {
    return path.join(getCoreRoot(), 'package.json');
}
