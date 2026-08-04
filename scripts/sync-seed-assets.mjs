#!/usr/bin/env node
/**
 * sync-seed-assets.mjs — 同步 QQ经典农场新种子图标到 seed_images_named/
 *
 * 数据流：
 *   微信本地缓存 cacheList.json → 当前 plant bundle config URL（最新版本）
 *   → 下载 config → 对比本地 seed_images_named 缺哪些 Crop_n_Seed
 *   → 下载缺失的 SpriteFrame(@f9941) + ASTC 纹理(native)
 *   → astcenc 解码 → sips 裁剪(rect) → 存 seed_images_named/{seed_id}_Crop_{n}_Seed.png
 *
 * 依赖（宿主机）：astcenc（https://github.com/ARM-software/astc-encoder 或 brew install astcenc）、
 *                 sips（macOS 内置）、curl
 *
 * 用法：
 *   node scripts/sync-seed-assets.mjs                 # 正常同步
 *   node scripts/sync-seed-assets.mjs --dry-run       # 只列出缺失种子
 *   node scripts/sync-seed-assets.mjs --config-url URL # 手动指定 plant config URL
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const IMG_DIR = path.join(PROJECT_ROOT, 'core', 'src', 'gameConfig', 'seed_images_named');
const APPID = 'wx5306c5978fdb76e4';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const HEX = '0123456789abcdef';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CONFIG_URL_ARG = args.find((a) => a.startsWith('--config-url='))?.split('=')[1];

// ---------- 工具 ----------
function log(...m) { console.log(...m); }
function sh(cmd, cwd) {
  return execFileSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function fetchUrl(url, dest) {
  execFileSync('curl', ['-sL', '-m', '60', '-o', dest, url], { stdio: 'pipe' });
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    throw new Error(`下载失败: ${url}`);
  }
}

// Cocos 压缩 uuid → 完整 uuid（算法提取自游戏引擎源码）
function decodeUuid(comp) {
  if (comp.length !== 22) return comp;
  const tmpl = [];
  const dashPos = [8, 13, 18, 23];
  for (let i = 0; i < 36; i++) tmpl.push(dashPos.includes(i) ? '-' : '');
  const pos = [];
  for (let i = 0; i < 36; i++) if (tmpl[i] !== '-') pos.push(i);
  tmpl[0] = comp[0];
  tmpl[1] = comp[1];
  let n = 2;
  for (let i = 2; i < 22; i += 2) {
    const r = B64.indexOf(comp[i]);
    const s = B64.indexOf(comp[i + 1]);
    tmpl[pos[n]] = HEX[r >> 2];
    tmpl[pos[n + 1]] = HEX[((3 & r) << 2) | (s >> 4)];
    tmpl[pos[n + 2]] = HEX[15 & s];
    n += 3;
  }
  return tmpl.join('');
}

// versions 稀疏数组 [idx, hash, idx, hash, ...]
function sparseLookup(arr, idx) {
  for (let i = 0; i < arr.length - 1; i += 2) {
    if (arr[i] === idx) return arr[i + 1];
  }
  return null;
}

// ---------- 1. 定位 plant config URL ----------
function findConfigUrl() {
  if (CONFIG_URL_ARG) return CONFIG_URL_ARG;
  // 从微信缓存 cacheList.json 找 plant config（用户最近玩过才有）
  const wxRoot = path.join(os.homedir(), 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'app_data', 'radium', 'users');
  const candidates = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'cacheList.json') candidates.push(p);
    }
  };
  walk(wxRoot);
  let best = null; // {url, lastTime}
  for (const c of candidates) {
    try {
      const d = JSON.parse(fs.readFileSync(c, 'utf8'));
      for (const [url, info] of Object.entries(d.files || {})) {
        if (url.includes('/remote/plant/config.') && url.endsWith('.json')) {
          const lastTime = Number(info?.lastTime || 0);
          if (!best || lastTime > best.lastTime) best = { url, lastTime };
        }
      }
    } catch { /* 跳过损坏的缓存 */ }
  }
  if (best) return best.url;
  throw new Error('未在微信缓存找到 plant config。请先在微信里打开一次游戏（让资源缓存），或用 --config-url 手动指定。');
}

// ---------- 2. 主流程 ----------
async function main() {
  // 依赖检查（PATH + 常见安装路径）
  let astcenc = null;
  const astcencCandidates = ['astcenc', '/usr/local/bin/astcenc', '/opt/homebrew/bin/astcenc', path.join(os.homedir(), 'bin', 'astcenc')];
  for (const c of astcencCandidates) {
    if (c === 'astcenc') { try { sh(['which', 'astcenc']); astcenc = 'astcenc'; break; } catch { /* PATH 无 */ } }
    else if (fs.existsSync(c)) { astcenc = c; break; }
  }
  if (!astcenc && !DRY_RUN) {
    log('⚠️ 未找到 astcenc，请先安装：brew install astcenc 或从 GitHub ARM-software/astc-encoder 下载');
    process.exit(1);
  }

  log('① 定位 plant config...');
  const cfgUrl = findConfigUrl();
  log(`   config: ${cfgUrl}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-sync-'));
  const cfgPath = path.join(tmp, 'config.json');
  fetchUrl(cfgUrl, cfgPath);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const { paths, uuids, versions = {} } = cfg;
  log(`   paths=${Object.keys(paths).length} uuids=${uuids.length}`);

  // ② 收集所有普通版 Crop_n_Seed（排除 gold 变体）
  const seeds = [];
  for (const [idxStr, p] of Object.entries(paths)) {
    const idx = Number(idxStr);
    const assetPath = p[0];
    const m = assetPath.match(/^model\/v4\/(Crop_(\d+)_Seed)$/);
    if (m) seeds.push({ idx, n: Number(m[2]), assetPath: m[1] });
  }
  seeds.sort((a, b) => a.n - b.n);
  log(`② 共发现 ${seeds.length} 个种子资源`);

  // ③ 对比本地已有
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const existing = fs.readdirSync(IMG_DIR);
  const missing = [];
  const existingCount = { n: 0 };
  for (const s of seeds) {
    const seedId = 20000 + s.n;
    const has = existing.some((f) => new RegExp(`^${seedId}_`).test(f));
    if (has) existingCount.n++;
    else missing.push({ ...s, seedId });
  }
  log(`③ 本地已有 ${existingCount.n} 个，缺失 ${missing.length} 个`);
  for (const s of missing) log(`   - seed ${s.seedId} (Crop_${s.n}_Seed)`);
  if (DRY_RUN) { log('（--dry-run，不下载）'); process.exit(0); }
  if (missing.length === 0) { log('✅ 无缺失，无需同步'); process.exit(0); }

  // ④ 逐个提取
  const success = [];
  const failed = [];
  for (const s of missing) {
    try {
      const compressed = uuids[s.idx];
      if (!compressed || compressed.length !== 22) { failed.push([s.seedId, 'uuids 无条目']); continue; }
      const full = decodeUuid(compressed);
      const sub = `${compressed}@f9941`;
      const subIdx = uuids.indexOf(sub);
      if (subIdx < 0) { failed.push([s.seedId, 'SpriteFrame 子资源缺失']); continue; }
      const sfHash = sparseLookup(versions.import || [], subIdx);
      const nativeHash = sparseLookup(versions.native || [], s.idx);
      if (!sfHash || !nativeHash) { failed.push([s.seedId, '版本 hash 缺失']); continue; }

      // 下载 SpriteFrame → rect
      const sfPath = path.join(tmp, `${s.n}_sf.json`);
      fetchUrl(`https://cdn-resource.nqf.qq.com/release/remote/plant/import/${full.slice(0, 2)}/${full}@f9941.${sfHash}.json`, sfPath);
      const sf = JSON.parse(fs.readFileSync(sfPath, 'utf8'));
      const sprite = sf?.[5]?.[0];
      const rect = sprite?.rect;
      if (!rect) { failed.push([s.seedId, 'SpriteFrame 无 rect']); continue; }
      if (sprite.rotated) { failed.push([s.seedId, 'rotated=true 暂不支持']); continue; }

      // 下载 ASTC → 解码 → 裁剪
      const astcPath = path.join(tmp, `${s.n}.astc`);
      const pngPath = path.join(tmp, `${s.n}.png`);
      const outPath = path.join(tmp, `${s.n}_crop.png`);
      fetchUrl(`https://cdn-resource.nqf.qq.com/release/remote/plant/native/${full.slice(0, 2)}/${full}.${nativeHash}.astc`, astcPath);
      sh([astcenc, '-dl', astcPath, pngPath]);
      sh(['sips', '-c', String(rect.height), String(rect.width), '--cropOffset', String(rect.y), String(rect.x), pngPath, '--out', outPath]);

      // 存入 seed_images_named
      const finalName = `${s.seedId}_Crop_${s.n}_Seed.png`;
      fs.copyFileSync(outPath, path.join(IMG_DIR, finalName));
      success.push([s.seedId, `Crop_${s.n}_Seed`, `${rect.width}x${rect.height}`]);
      log(`   ✅ ${finalName}`);
    } catch (e) {
      failed.push([s.seedId, e.message.slice(0, 80)]);
      log(`   ❌ seed ${s.seedId}: ${e.message.slice(0, 80)}`);
    }
  }

  log(`\n完成：成功 ${success.length}，失败 ${failed.length}`);
  if (failed.length) {
    log('失败明细：');
    for (const [id, reason] of failed) log(`   - ${id}: ${reason}`);
    log('提示：可重跑本脚本继续同步未成功的项；下次游戏活动更新后再次运行即可同步新种子。');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => { console.error('脚本失败:', e.message); process.exit(1); });
