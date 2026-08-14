import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDataFile } from '../config/runtime-paths';
import { readJsonFile, writeJsonFileAtomic } from '../services/json-db';

interface KnownFriendCacheData {
    gids?: unknown;
}

export interface KnownFriendCacheDependencies {
    getDataFile: (filename: string) => string;
    readJsonFile: typeof readJsonFile;
    writeJsonFileAtomic: typeof writeJsonFileAtomic;
}

export interface KnownFriendCache {
    read: (accountId: unknown) => unknown[] | null;
    write: (accountId: unknown, gids: readonly unknown[] | null | undefined) => void;
}

export function createKnownFriendCache(
    dependencies: KnownFriendCacheDependencies = {
        getDataFile,
        readJsonFile,
        writeJsonFileAtomic,
    },
): KnownFriendCache {
    const cacheDir = dependencies.getDataFile('known_friend_gids');
    const ensureCacheDir = () => {
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        return cacheDir;
    };
    const getCacheFile = (accountId: unknown) => {
        const safeId = String(accountId || '').replace(/[^\w-]/g, '_');
        return path.join(ensureCacheDir(), `${safeId}.json`);
    };
    return {
        read(accountId: unknown): unknown[] | null {
            try {
                const file = getCacheFile(accountId);
                if (!fs.existsSync(file)) return null;
                const data = dependencies.readJsonFile<KnownFriendCacheData>(file);
                return Array.isArray(data.gids) ? data.gids : null;
            } catch {
                return null;
            }
        },
        write(accountId: unknown, gids: readonly unknown[] | null | undefined): void {
            try {
                const file = getCacheFile(accountId);
                dependencies.writeJsonFileAtomic(file, {
                    gids: gids || [],
                    updatedAt: Date.now(),
                });
            } catch {
                // 缓存写入失败不影响主配置流程
            }
        },
    };
}
