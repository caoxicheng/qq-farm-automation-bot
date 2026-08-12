#!/usr/bin/env node
/**
 * @deprecated 使用 `pnpm game-data sync`。删除条件见根目录 TODO.md。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forwarded = process.argv.slice(2).filter((argument) => argument === '--dry-run');
console.warn('[deprecated] scripts/sync-seed-assets.mjs 已弃用，请改用 pnpm game-data sync');
execFileSync(process.execPath, [path.join(root, 'scripts', 'game-data.mjs'), 'sync', ...forwarded], { stdio: 'inherit' });
