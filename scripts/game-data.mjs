#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_VERSION, buildCatalogs, collectPlantSpecs, extractPlantImage, findOfficialDatasets,
  findPlantBundle, findUnparsedSaleItemIds, hashBytes, hashJson, stableJson,
} from './game-data/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = path.join(ROOT, 'core', 'src', 'gameConfig');
const BUNDLE_DIR = path.join(ROOT, 'core', 'resources', 'game-data');
const REPORT_PATH = path.join(ROOT, 'artifacts', 'game-data-report.json');
const command = process.argv[2] || 'check';
const dryRun = process.argv.includes('--dry-run');

function readJson(target) { return JSON.parse(fs.readFileSync(target, 'utf8')); }
function config(name) { return readJson(path.join(CONFIG_DIR, name)); }
function locateAstcenc() {
  for (const candidate of ['astcenc', '/opt/homebrew/bin/astcenc', '/usr/local/bin/astcenc', path.join(os.homedir(), 'bin', 'astcenc')]) {
    try { if (candidate === 'astcenc') execFileSync('which', [candidate], { stdio: 'ignore' }); else if (!fs.existsSync(candidate)) continue; return candidate; } catch { /* 继续 */ }
  }
  return null;
}
function fetchJson(url, tempDir) {
  const target = path.join(tempDir, 'plant-config.json');
  execFileSync('curl', ['-fsSL', '-m', '60', '-o', target, url], { stdio: 'pipe' });
  return readJson(target);
}
function duplicateIds(rows) {
  const seen = new Set(); const duplicate = new Set();
  for (const row of rows) { if (seen.has(row.id)) duplicate.add(row.id); seen.add(row.id); }
  return [...duplicate];
}
function validSaleRewards(rows) {
  return Array.isArray(rows) && rows.every((row) => Number.isSafeInteger(row?.id) && row.id > 0 && Number.isSafeInteger(row?.amount) && row.amount > 0);
}
function assertOverrides(overrides) {
  const errors = [];
  for (const row of overrides) if (!Number(row.id) || !String(row.name || '').trim() || !String(row.evidence || '').trim()) errors.push(`override ${row.id || '?'} 缺少 id/name/evidence`);
  if (duplicateIds(overrides).length) errors.push('override 存在重复 ID');
  if (errors.length) throw new Error(errors.join('\n'));
}
function previousAssetIndex() {
  try { return readJson(path.join(BUNDLE_DIR, 'manifest.json')).assets.index; } catch { return []; }
}
function materializeAssets({ plantConfig, plantSpecs, tempDir }) {
  const previous = previousAssetIndex();
  const previousByKey = new Map(previous.map((row) => [`${row.id}:${row.variant}`, row]));
  const logical = [];
  const astcenc = locateAstcenc();
  for (const spec of plantSpecs) {
    const key = `${spec.id}:${spec.variant}`;
    const old = previousByKey.get(key);
    const oldFile = old && path.join(BUNDLE_DIR, 'assets', `${old.contentHash}.${old.extension}`);
    if (old?.sourceHash === spec.sourceHash && fs.existsSync(oldFile)) {
      logical.push({ ...old, sourcePath: oldFile });
      continue;
    }
    if (!spec.nativeHash) throw new Error(`资源 ${spec.id}/${spec.variant} 指向 redirect bundle，但仓库没有可复用图片`);
    if (!astcenc) throw new Error('发现需更新图片但未找到 astcenc，请先执行 brew install astcenc');
    const extracted = extractPlantImage(spec, plantConfig, tempDir, astcenc);
    const bytes = fs.readFileSync(extracted);
    logical.push({ id: spec.id, assetName: spec.assetName, variant: spec.variant, contentHash: hashBytes(bytes), extension: 'png', originalName: `${spec.id}_${spec.assetName}_${spec.variant}.png`, sourceHash: spec.sourceHash, sourcePath: extracted });
  }
  const knownKeys = new Set(logical.map((row) => `${row.id}:${row.variant}`));
  for (const asset of previous) {
    if (asset.id && knownKeys.has(`${asset.id}:${asset.variant}`)) continue;
    const sourcePath = path.join(BUNDLE_DIR, 'assets', `${asset.contentHash}.${asset.extension}`);
    if (!fs.existsSync(sourcePath)) throw new Error(`旧资源索引引用缺失图片: ${path.basename(sourcePath)}`);
    logical.push({ ...asset, sourcePath });
  }
  return logical.sort((a, b) => (a.id || 0) - (b.id || 0) || a.variant.localeCompare(b.variant) || a.originalName.localeCompare(b.originalName));
}
function publicAsset(row) {
  return { id: row.id, assetName: row.assetName, variant: row.variant, contentHash: row.contentHash, extension: row.extension, originalName: row.originalName, sourceHash: row.sourceHash || null };
}
function buildManifest({ mainsceneBundleId, plantBundleId, officialItems, officialPlants, overrides, items, plants, sales, assets }) {
  const index = assets.map(publicAsset);
  return {
    schemaVersion: SCHEMA_VERSION,
    bundleVersion: mainsceneBundleId,
    sources: { mainscene: mainsceneBundleId, plant: plantBundleId, itemInfoHash: hashJson(officialItems), plantHash: hashJson(officialPlants), overridesHash: hashJson(overrides) },
    catalogs: {
      items: { file: 'catalogs/items.json', sha256: hashJson(items), count: items.length },
      plants: { file: 'catalogs/plants.json', sha256: hashJson(plants), count: plants.length },
      sales: { file: 'catalogs/sales.json', sha256: hashJson(sales), count: sales.length },
    },
    assets: { count: index.length, uniqueCount: new Set(index.map((row) => row.contentHash)).size, indexHash: hashJson(index), index },
  };
}
function validateBundle(bundleDir, { legacyItems, overrides } = {}) {
  const manifest = readJson(path.join(bundleDir, 'manifest.json'));
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error(`不支持的资源 schema: ${manifest.schemaVersion}`);
  if (!manifest.catalogs?.sales) throw new Error('资源包缺少 sales catalog');
  const items = readJson(path.join(bundleDir, manifest.catalogs.items.file));
  const plants = readJson(path.join(bundleDir, manifest.catalogs.plants.file));
  const sales = readJson(path.join(bundleDir, manifest.catalogs.sales.file));
  const errors = [];
  if (hashJson(items) !== manifest.catalogs.items.sha256 || items.length !== manifest.catalogs.items.count) errors.push('items catalog 哈希或数量不匹配');
  if (hashJson(plants) !== manifest.catalogs.plants.sha256 || plants.length !== manifest.catalogs.plants.count) errors.push('plants catalog 哈希或数量不匹配');
  if (hashJson(sales) !== manifest.catalogs.sales.sha256 || sales.length !== manifest.catalogs.sales.count) errors.push('sales catalog 哈希或数量不匹配');
  if (hashJson(manifest.assets.index) !== manifest.assets.indexHash) errors.push('图片索引哈希不匹配');
  if (duplicateIds(items).length) errors.push('items catalog 存在重复 ID');
  if (duplicateIds(plants).length) errors.push('plants catalog 存在重复 ID');
  if (duplicateIds(sales).length) errors.push('sales catalog 存在重复 ID');
  const itemIds = new Set(items.map((row) => Number(row.id)));
  const itemById = new Map(items.map((row) => [Number(row.id), row]));
  for (const sale of sales) {
    const rewards = Array.isArray(sale.rewards) ? sale.rewards : [];
    const conditionalRewards = Array.isArray(sale.conditionalRewards) ? sale.conditionalRewards : [];
    if (!Number.isSafeInteger(sale.id) || sale.id <= 0) errors.push(`出售策略 ${sale.id} 的物品 ID 无效`);
    if (!itemIds.has(sale.id)) errors.push(`出售策略 ${sale.id} 缺少对应物品`);
    if (![6, 17].includes(sale.itemType)) errors.push(`出售策略 ${sale.id} 的物品类型无效`);
    if (itemById.has(sale.id) && Number(itemById.get(sale.id).itemType) !== sale.itemType) errors.push(`出售策略 ${sale.id} 的物品类型与目录不匹配`);
    if (!['available', 'conditional'].includes(sale.status)) errors.push(`出售策略 ${sale.id} 的状态无效`);
    if (!['official', 'legacy'].includes(sale.source)) errors.push(`出售策略 ${sale.id} 的来源无效`);
    if (!validSaleRewards(sale.rewards) || !validSaleRewards(sale.conditionalRewards)) errors.push(`出售策略 ${sale.id} 的奖励无效`);
    for (const reward of [...rewards, ...conditionalRewards]) if (!itemIds.has(reward.id)) errors.push(`出售策略 ${sale.id} 的奖励 ${reward.id} 缺少对应物品`);
    if (sale.status === 'available' && (sale.condition || rewards.length === 0)) errors.push(`出售策略 ${sale.id} 的可售状态无效`);
    if (sale.status === 'conditional' && !sale.condition && conditionalRewards.length === 0) errors.push(`出售策略 ${sale.id} 缺少出售条件`);
  }
  const relationships = new Set(plants.filter((row) => row.seedId && row.fruitId).map((row) => `${row.seedId}:${row.fruitId}`));
  for (const item of items) if (item.relatedSeedId && item.relatedFruitId && !relationships.has(`${item.relatedSeedId}:${item.relatedFruitId}`)) errors.push(`物品 ${item.id} 关联无对应植物`);
  const expectedFiles = new Set();
  for (const asset of manifest.assets.index) {
    const filename = `${asset.contentHash}.${asset.extension}`; expectedFiles.add(filename);
    const target = path.join(bundleDir, 'assets', filename);
    if (!fs.existsSync(target)) { errors.push(`图片缺失: ${filename}`); continue; }
    const bytes = fs.readFileSync(target);
    if (hashBytes(bytes) !== asset.contentHash) errors.push(`图片哈希错误: ${filename}`);
    if (asset.extension === 'png' && bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') errors.push(`PNG 损坏: ${filename}`);
  }
  const actualFiles = fs.existsSync(path.join(bundleDir, 'assets')) ? fs.readdirSync(path.join(bundleDir, 'assets')) : [];
  for (const filename of actualFiles) if (!expectedFiles.has(filename)) errors.push(`未登记图片: ${filename}`);
  if (legacyItems && hashJson(legacyItems) !== manifest.sources.legacyItemInfoHash) errors.push('ItemInfo.json 已变化，请重新同步资源包');
  if (overrides && hashJson(overrides) !== manifest.sources.overridesHash) errors.push('item-overrides.json 已变化，请重新同步资源包');
  if (errors.length) throw new Error(errors.slice(0, 30).join('\n'));
  return { manifest, items, plants, sales };
}
function createStage({ datasets, plantBundle, plantConfig, assets, overrides, legacyItems, tempDir }) {
  const { items, plants, sales } = buildCatalogs({ officialItems: datasets.items, officialPlants: datasets.plants, legacyItems, overrides, assets });
  const manifest = buildManifest({ mainsceneBundleId: datasets.bundleId, plantBundleId: plantBundle.bundleId, officialItems: datasets.items, officialPlants: datasets.plants, overrides, items, plants, sales, assets });
  manifest.sources.legacyItemInfoHash = hashJson(legacyItems);
  const stage = path.join(tempDir, 'game-data');
  fs.mkdirSync(path.join(stage, 'catalogs'), { recursive: true }); fs.mkdirSync(path.join(stage, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'catalogs', 'items.json'), stableJson(items));
  fs.writeFileSync(path.join(stage, 'catalogs', 'plants.json'), stableJson(plants));
  fs.writeFileSync(path.join(stage, 'catalogs', 'sales.json'), stableJson(sales));
  const copied = new Set();
  for (const asset of assets) {
    const filename = `${asset.contentHash}.${asset.extension}`;
    if (!copied.has(filename)) fs.copyFileSync(asset.sourcePath, path.join(stage, 'assets', filename));
    copied.add(filename);
  }
  fs.writeFileSync(path.join(stage, 'manifest.json'), stableJson(manifest));
  validateBundle(stage, { legacyItems, overrides });
  return { stage, manifest, items, plants, sales };
}
function replaceDirectory(stage) {
  fs.mkdirSync(path.dirname(BUNDLE_DIR), { recursive: true });
  const backup = `${BUNDLE_DIR}.backup-${process.pid}`;
  if (fs.existsSync(BUNDLE_DIR)) fs.renameSync(BUNDLE_DIR, backup);
  try { fs.renameSync(stage, BUNDLE_DIR); }
  catch (error) {
    if (fs.existsSync(backup) && !fs.existsSync(BUNDLE_DIR)) fs.renameSync(backup, BUNDLE_DIR);
    throw error;
  }
  try { fs.rmSync(backup, { recursive: true, force: true }); }
  catch (error) { console.warn(`新资源包已发布，但旧备份清理失败：${error.message}`); }
}
function readPreviousCatalogs() {
  try {
    const manifest = readJson(path.join(BUNDLE_DIR, 'manifest.json'));
    return {
      items: readJson(path.join(BUNDLE_DIR, manifest.catalogs.items.file)),
      plants: readJson(path.join(BUNDLE_DIR, manifest.catalogs.plants.file)),
      sales: manifest.catalogs.sales ? readJson(path.join(BUNDLE_DIR, manifest.catalogs.sales.file)) : [],
    };
  } catch { return { items: [], plants: [], sales: [] }; }
}
function catalogDiff(beforeRows, afterRows) {
  const before = new Map(beforeRows.map((row) => [row.id, row]));
  const after = new Map(afterRows.map((row) => [row.id, row]));
  return {
    addedIds: afterRows.filter((row) => !before.has(row.id)).map((row) => row.id),
    changedIds: afterRows.filter((row) => before.has(row.id) && hashJson(before.get(row.id)) !== hashJson(row)).map((row) => row.id),
    disappearedIds: beforeRows.filter((row) => !after.has(row.id)).map((row) => row.id),
  };
}
function report(result, officialItems, legacyItems, overrides, previous) {
  const legacy = new Map(legacyItems.map((row) => [Number(row.id), row]));
  const plantRelations = new Set(result.plants.filter((row) => row.seedId && row.fruitId).map((row) => `${row.seedId}:${row.fruitId}`));
  const referencedImageHashes = new Set(result.items.map((row) => row.imageHash).filter(Boolean));
  const unparsedSaleItemIds = findUnparsedSaleItemIds({ officialItems, legacyItems, sales: result.sales });
  return {
    bundleVersion: result.manifest.bundleVersion,
    counts: {
      items: result.items.length,
      plants: result.plants.length,
      salePolicies: result.sales.length,
      availableRegularFruitSales: result.sales.filter((row) => row.status === 'available' && row.itemType === 6).length,
      availableSuperFruitSales: result.sales.filter((row) => row.status === 'available' && row.itemType === 17).length,
      conditionalSales: result.sales.filter((row) => row.status === 'conditional').length,
      unparsedSalePrices: unparsedSaleItemIds.length,
      logicalAssets: result.manifest.assets.count,
      uniqueAssets: result.manifest.assets.uniqueCount,
    },
    changes: { items: catalogDiff(previous.items, result.items), plants: catalogDiff(previous.plants, result.plants), sales: catalogDiff(previous.sales, result.sales) },
    quality: {
      unnamedItemIds: result.items.filter((row) => row.name === `物品 #${row.id}`).map((row) => row.id),
      namedWithoutImageIds: result.items.filter((row) => ['seed', 'fruit'].includes(row.kind) && row.name !== `物品 #${row.id}` && !row.imageHash).map((row) => row.id),
      imageWithoutOfficialNameIds: result.items.filter((row) => row.imageHash && row.name === `物品 #${row.id}`).map((row) => row.id),
      unreferencedAssetNames: result.manifest.assets.index.filter((row) => !referencedImageHashes.has(row.contentHash)).map((row) => row.originalName),
      unresolvedRelationshipIds: result.items.filter((row) => row.relatedSeedId && row.relatedFruitId && !plantRelations.has(`${row.relatedSeedId}:${row.relatedFruitId}`)).map((row) => row.id),
      duplicateItemIds: duplicateIds(result.items),
      duplicatePlantIds: duplicateIds(result.plants),
      unparsedSaleItemIds,
    },
    addedSinceLegacyIds: result.items.filter((row) => row.source === 'official' && !legacy.has(row.id)).map((row) => row.id),
    overrides: overrides.map((row) => ({ id: row.id, name: row.name, evidence: row.evidence })),
  };
}
function printDiff(stage) {
  let before = null;
  try { before = readJson(path.join(BUNDLE_DIR, 'manifest.json')); } catch { /* 首次迁移 */ }
  const after = readJson(path.join(stage, 'manifest.json'));
  console.log(`资源包 ${before?.bundleVersion || '无'} → ${after.bundleVersion}`);
  console.log(`物品 ${after.catalogs.items.count}，植物 ${after.catalogs.plants.count}，出售策略 ${after.catalogs.sales.count}，图片 ${after.assets.count}/${after.assets.uniqueCount}（逻辑/唯一）`);
  console.log(before && hashJson(before) === hashJson(after) ? '资源包无变化' : '资源包有变化');
}

if (command === 'scan') {
  const datasets = findOfficialDatasets(); const plant = findPlantBundle();
  console.log(`mainscene=${datasets.bundleId}（ItemInfo ${datasets.items.length}，Plant ${datasets.plants.length}），plant=${plant.bundleId}`);
} else if (command === 'sync') {
  if (process.platform !== 'darwin') throw new Error('资源同步仅支持 macOS；普通用户不需要执行此命令');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-data-sync-'));
  try {
    const previous = readPreviousCatalogs();
    const datasets = findOfficialDatasets(); const plantBundle = findPlantBundle(); const plantConfig = fetchJson(plantBundle.url, tempDir);
    const plantSpecs = collectPlantSpecs(plantConfig); const overrides = config('item-overrides.json'); const legacyItems = config('ItemInfo.json');
    assertOverrides(overrides);
    const assets = materializeAssets({ plantConfig, plantSpecs, tempDir });
    const result = createStage({ datasets, plantBundle, plantConfig, assets, overrides, legacyItems, tempDir });
    printDiff(result.stage);
    if (dryRun) console.log('dry-run：已完成完整生成和校验，未修改仓库');
    else {
      replaceDirectory(result.stage);
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true }); fs.writeFileSync(REPORT_PATH, stableJson(report(result, datasets.items, legacyItems, overrides, previous)));
      console.log('已原子发布资源包');
    }
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
} else if (command === 'check') {
  const overrides = config('item-overrides.json'); const legacyItems = config('ItemInfo.json'); assertOverrides(overrides);
  const result = validateBundle(BUNDLE_DIR, { legacyItems, overrides });
  console.log(`资源包检查通过：物品 ${result.items.length}，植物 ${result.plants.length}，出售策略 ${result.sales.length}，图片 ${result.manifest.assets.count}/${result.manifest.assets.uniqueCount}`);
} else {
  console.log('用法: node scripts/game-data.mjs <scan|sync|check> [--dry-run]'); process.exitCode = 1;
}
