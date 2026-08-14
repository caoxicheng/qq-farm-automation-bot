import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APPID = 'wx5306c5978fdb76e4';
export const SCHEMA_VERSION = 2;
export const TEXT_ASSET_KEY = Buffer.from('NQF_SHANGXIANDAMAI_#2026_SECURE');
const CDN_ROOT = 'https://cdn-resource.nqf.qq.com/release/remote';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const HEX = '0123456789abcdef';

export function stableJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
export function hashBytes(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
export function hashJson(value) { return hashBytes(stableJson(value)); }

export function decodeTextAsset(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('TextAsset 不是有效的 Base64 字符串');
  const encrypted = Buffer.from(value, 'base64');
  if (!encrypted.length) throw new Error('TextAsset 内容为空');
  const decoded = Buffer.allocUnsafe(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) decoded[i] = encrypted[i] ^ TEXT_ASSET_KEY[i % TEXT_ASSET_KEY.length];
  try {
    const data = JSON.parse(decoded.toString('utf8'));
    if (!Array.isArray(data)) throw new Error('结果不是数组');
    return data;
  } catch (error) { throw new Error(`TextAsset 解码失败，微信资源格式可能已更新：${error.message}`); }
}

function walkFiles(root, predicate, result = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(target, predicate, result);
    else if (predicate(target, entry.name)) result.push(target);
  }
  return result;
}

export function wechatCacheRoot() {
  return path.join(os.homedir(), 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'app_data', 'radium', 'users');
}

export function decodeUuid(comp) {
  if (comp.length !== 22) return comp;
  const output = []; const dash = [8, 13, 18, 23];
  for (let i = 0; i < 36; i++) output.push(dash.includes(i) ? '-' : '');
  const positions = [];
  for (let i = 0; i < 36; i++) if (output[i] !== '-') positions.push(i);
  output[0] = comp[0]; output[1] = comp[1];
  let position = 2;
  for (let i = 2; i < 22; i += 2) {
    const first = B64.indexOf(comp[i]); const second = B64.indexOf(comp[i + 1]);
    output[positions[position]] = HEX[first >> 2];
    output[positions[position + 1]] = HEX[((first & 3) << 2) | (second >> 4)];
    output[positions[position + 2]] = HEX[second & 15];
    position += 3;
  }
  return output.join('');
}

function sparseLookup(values, index) {
  for (let i = 0; i < values.length - 1; i += 2) if (values[i] === index) return values[i + 1];
  return null;
}

function localCachePath(cacheListPath, entry) {
  const relative = String(entry?.url || '').replace(/^wxfile:\/\/usr\//, '');
  if (!relative || relative.includes('..')) return null;
  return path.resolve(path.dirname(cacheListPath), '..', relative);
}

function readBundleAsset(cacheList, cacheListPath, bundle, assetPath) {
  const pathEntry = Object.entries(bundle.paths || {}).find(([, value]) => value?.[0] === assetPath);
  if (!pathEntry) throw new Error(`缺少 ${assetPath}`);
  const index = Number(pathEntry[0]);
  const compressed = bundle.uuids?.[index];
  const hash = sparseLookup(bundle.versions?.import || [], index);
  if (!compressed || !hash) throw new Error(`${assetPath} 缺少 UUID/hash`);
  const uuid = decodeUuid(compressed);
  const remote = `${CDN_ROOT}/mainscene/import/${uuid.slice(0, 2)}/${uuid}.${hash}.json`;
  const local = localCachePath(cacheListPath, cacheList.files?.[remote]);
  if (!local || !fs.existsSync(local)) throw new Error(`${assetPath} 尚未缓存`);
  const wrapper = JSON.parse(fs.readFileSync(local, 'utf8'));
  return decodeTextAsset(wrapper?.[5]?.[0]?.[2]);
}

export function findOfficialDatasets(cacheRoot = wechatCacheRoot()) {
  const lists = walkFiles(cacheRoot, (_target, name) => name === 'cacheList.json').filter((file) => file.includes(APPID));
  const candidates = [];
  for (const cacheListPath of lists) {
    let cacheList;
    try { cacheList = JSON.parse(fs.readFileSync(cacheListPath, 'utf8')); } catch { continue; }
    for (const [url, entry] of Object.entries(cacheList.files || {})) {
      const match = url.match(/\/remote\/mainscene\/config\.([^.]+)\.json$/);
      if (match) candidates.push({ cacheListPath, cacheList, entry, bundleId: match[1], lastTime: Number(entry?.lastTime) || 0 });
    }
  }
  candidates.sort((a, b) => b.lastTime - a.lastTime);
  if (!candidates.length) throw new Error('未找到 QQ 农场 mainscene 缓存，请先在微信中打开一次小游戏');
  const rejected = [];
  for (const candidate of candidates) {
    try {
      const bundlePath = localCachePath(candidate.cacheListPath, candidate.entry);
      const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
      const items = readBundleAsset(candidate.cacheList, candidate.cacheListPath, bundle, 'config/ItemInfo');
      const plants = readBundleAsset(candidate.cacheList, candidate.cacheListPath, bundle, 'config/Plant');
      if (!items.some((row) => 'interaction_type' in row) || !plants.some((row) => 'seed_id' in row && 'fruit' in row)) throw new Error('数据类型不匹配');
      return { items, plants, bundleId: candidate.bundleId };
    } catch (error) { rejected.push(`${candidate.bundleId}: ${error.message}`); }
  }
  throw new Error(`没有完整可用的 mainscene bundle：${rejected.slice(0, 3).join('；')}`);
}

export function findPlantBundle(cacheRoot = wechatCacheRoot()) {
  const lists = walkFiles(cacheRoot, (_target, name) => name === 'cacheList.json').filter((file) => file.includes(APPID));
  let selected = null;
  for (const file of lists) {
    let cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (const [url, entry] of Object.entries(cache.files || {})) {
      const match = url.match(/\/remote\/plant\/config\.([^.]+)\.json$/);
      if (match && (!selected || Number(entry?.lastTime) > selected.lastTime)) selected = { url, bundleId: match[1], lastTime: Number(entry?.lastTime) || 0 };
    }
  }
  if (!selected) throw new Error('未找到 plant bundle，请先在微信中打开一次小游戏');
  return selected;
}

function run(command, args) { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function fetchFile(url, target) {
  run('curl', ['-fsSL', '-m', '60', '-o', target, url]);
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) throw new Error(`下载失败: ${url}`);
}

export function collectPlantSpecs(config) {
  const specs = [];
  for (const [indexText, value] of Object.entries(config.paths || {})) {
    const index = Number(indexText); const assetPath = value?.[0] || '';
    const seed = assetPath.match(/^model\/v4\/(Crop_(\d+)_Seed)$/);
    const mature = assetPath.match(/^model\/v4\/(Crop_(\d+)_6)$/);
    if (!seed && !mature) continue;
    const number = Number((seed || mature)[2]);
    const id = (seed ? 20000 : 40000) + number;
    const compressed = config.uuids?.[index];
    const nativeHash = sparseLookup(config.versions?.native || [], index);
    const subIndex = config.uuids?.indexOf(`${compressed}@f9941`) ?? -1;
    const importHash = subIndex >= 0 ? sparseLookup(config.versions?.import || [], subIndex) : null;
    if (!compressed) throw new Error(`资源 ${assetPath} 缺少 UUID`);
    const redirectIndex = (() => {
      for (let i = 0; i < (config.redirect || []).length - 1; i += 2) if (config.redirect[i] === index) return config.redirect[i + 1];
      return null;
    })();
    specs.push({ id, assetName: `Crop_${number}`, variant: seed ? 'seed' : 'mature', index, compressed, nativeHash, importHash, subIndex, redirectIndex, sourceHash: hashJson({ compressed, nativeHash, importHash, redirectIndex }) });
  }
  return specs.sort((a, b) => a.id - b.id || a.variant.localeCompare(b.variant));
}

export function extractPlantImage(spec, config, tempDir, astcenc) {
  const uuid = decodeUuid(spec.compressed);
  const astc = path.join(tempDir, `${spec.id}.astc`);
  const png = path.join(tempDir, `${spec.id}.png`);
  fetchFile(`${CDN_ROOT}/plant/native/${uuid.slice(0, 2)}/${uuid}.${spec.nativeHash}.astc`, astc);
  run(astcenc, ['-dl', astc, png]);
  if (spec.subIndex < 0) return png;
  const spriteFile = path.join(tempDir, `${spec.id}.json`);
  fetchFile(`${CDN_ROOT}/plant/import/${uuid.slice(0, 2)}/${uuid}@f9941.${spec.importHash}.json`, spriteFile);
  const sprite = JSON.parse(fs.readFileSync(spriteFile, 'utf8'))?.[5]?.[0];
  if (!sprite?.rect || sprite.rotated) throw new Error(`资源 ${spec.id} 的 SpriteFrame 不受支持`);
  const output = path.join(tempDir, `${spec.id}-crop.png`);
  run('sips', ['-c', String(sprite.rect.height), String(sprite.rect.width), '--cropOffset', String(sprite.rect.y), String(sprite.rect.x), png, '--out', output]);
  return output;
}

function itemKind(item, id, seedIds, fruitIds) {
  if (seedIds.has(id) || Number(item?.type) === 5 || (id >= 20000 && id < 30000)) return 'seed';
  if (fruitIds.has(id) || [6, 17].includes(Number(item?.type)) || (id >= 40000 && id < 50000)) return 'fruit';
  if ([1, 1001, 1002, 1004, 1005, 1014, 1023, 1101].includes(id)) return 'currency';
  if (Number(item?.type) === 10 || id >= 200000) return 'decoration';
  return String(item?.interaction_type || '').trim() ? 'tool' : item ? 'item' : 'unknown';
}

export function parseSaleRewards(value, itemId = 0) {
  const text = String(value || '').trim();
  if (!text) return [];
  const merged = new Map();
  for (const part of text.split(';')) {
    const match = part.trim().match(/^(\d+):(\d+)$/);
    if (!match) throw new Error(`物品 ${itemId || '?'} 的出售奖励格式无效: ${text}`);
    const id = Number(match[1]);
    const amount = Number(match[2]);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`物品 ${itemId || '?'} 的出售奖励数值无效: ${text}`);
    }
    merged.set(id, (merged.get(id) || 0) + amount);
  }
  return [...merged.entries()].map(([id, amount]) => ({ id, amount }));
}

function directSaleRewards(item) {
  const sells = String(item?.sells || '').trim();
  if (sells) return parseSaleRewards(sells, item?.id);
  const amount = Number(item?.price) || 0;
  if (!amount) return [];
  const id = Number(item?.price_id) || 1001;
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`物品 ${item?.id || '?'} 的旧版出售价格无效`);
  }
  return [{ id, amount }];
}

function parsePrice(item) {
  return directSaleRewards(item)[0] || null;
}

function buildItemSources(officialItems, legacyItems) {
  return {
    official: new Map(officialItems.map((row) => [Number(row.id), row])),
    legacy: new Map(legacyItems.map((row) => [Number(row.id), row])),
  };
}

export function buildSalePolicies({ officialItems, legacyItems }) {
  const { official, legacy } = buildItemSources(officialItems, legacyItems);
  const ids = new Set([...official.keys(), ...legacy.keys()]);
  const sales = [];
  for (const id of [...ids].filter((value) => value > 0).sort((a, b) => a - b)) {
    const raw = official.get(id) || legacy.get(id);
    const itemType = Number(raw?.type) || 0;
    if (itemType !== 6 && itemType !== 17) continue;
    const rewards = directSaleRewards(raw);
    const condition = String(raw?.sell_cond || '').trim() || null;
    const conditionalRewards = parseSaleRewards(raw?.cond_sells, id);
    if (!rewards.length && !conditionalRewards.length) continue;
    sales.push({
      id,
      itemType,
      status: condition || !rewards.length ? 'conditional' : 'available',
      rewards,
      condition,
      conditionalRewards,
      source: official.has(id) ? 'official' : 'legacy',
    });
  }
  return sales;
}

export function findUnparsedSaleItemIds({ officialItems, legacyItems, sales }) {
  const { official, legacy } = buildItemSources(officialItems, legacyItems);
  const policyIds = new Set(sales.map((row) => Number(row.id)));
  const ids = new Set([...official.keys(), ...legacy.keys()]);
  return [...ids]
    .filter((id) => {
      if (id <= 0 || policyIds.has(id)) return false;
      const itemType = Number((official.get(id) || legacy.get(id))?.type) || 0;
      return itemType === 6 || itemType === 17;
    })
    .sort((a, b) => a - b);
}

export function buildCatalogs({ officialItems, officialPlants, legacyItems, overrides, assets }) {
  const official = new Map(officialItems.map((row) => [Number(row.id), row]));
  const legacy = new Map(legacyItems.map((row) => [Number(row.id), row]));
  const override = new Map(overrides.map((row) => [Number(row.id), row]));
  const plants = officialPlants.map((row) => ({ id: Number(row.id) || null, name: String(row.name || '').trim() || null, seedId: Number(row.seed_id) || null, fruitId: Number(row.fruit?.id) || null, level: Number(row.land_level_need) || null, source: 'official' })).sort((a, b) => (a.id || 0) - (b.id || 0));
  const bySeed = new Map(plants.filter((row) => row.seedId).map((row) => [row.seedId, row]));
  const byFruit = new Map(plants.filter((row) => row.fruitId).map((row) => [row.fruitId, row]));
  const assetById = new Map(); const assetByName = new Map();
  for (const asset of assets) {
    if (asset.id && !assetById.has(asset.id)) assetById.set(asset.id, asset);
    if (asset.assetName && !assetByName.has(asset.assetName)) assetByName.set(asset.assetName, asset);
  }
  const ids = new Set([...official.keys(), ...legacy.keys(), ...override.keys(), ...assets.map((row) => row.id).filter(Boolean), ...bySeed.keys(), ...byFruit.keys()]);
  const items = [...ids].filter((id) => id > 0).sort((a, b) => a - b).map((id) => {
    const raw = official.get(id) || legacy.get(id) || null; const plant = bySeed.get(id) || byFruit.get(id); const patch = override.get(id);
    const kind = itemKind(raw, id, bySeed, byFruit);
    const name = String(patch?.name || official.get(id)?.name || legacy.get(id)?.name || (plant?.name ? `${plant.name}${kind === 'seed' ? '种子' : ''}` : '')).trim() || `物品 #${id}`;
    const directAsset = assetById.get(id); const namedAsset = assetByName.get(String(raw?.asset_name || '').trim());
    return { id, name, kind, itemType: Number(raw?.type) || (kind === 'seed' ? 5 : kind === 'fruit' ? 6 : null), imageHash: (directAsset || namedAsset)?.contentHash || null, assetName: String(raw?.asset_name || '').trim() || null, relatedSeedId: plant?.seedId || null, relatedFruitId: plant?.fruitId || null, level: Number(raw?.level ?? plant?.level) || null, price: parsePrice(raw), source: patch ? 'override' : official.has(id) ? 'official' : legacy.has(id) ? 'legacy' : 'inferred' };
  });
  const sales = buildSalePolicies({ officialItems, legacyItems });
  return { items, plants, sales };
}
