/* eslint-disable test/no-import-node-test */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPID, decodeTextAsset, findOfficialDatasets, TEXT_ASSET_KEY } from '../../scripts/game-data/lib.mjs';

const GOLDEN_FIXTURE = 'FSpkNjdqe3p2a3FxYmYvLCwsfRkQ1pCRufLVYXlwMTchI31pfjwT';

test('解码微信 Cocos TextAsset golden fixture', () => {
  assert.deepEqual(decodeTextAsset(GOLDEN_FIXTURE), [{ id: 41380, name: '梧桐', type: 6 }]);
});

test('编码格式变化时安全失败', () => {
  assert.throws(() => decodeTextAsset('not base64'), /Base64/);
  assert.throws(() => decodeTextAsset(Buffer.from('unknown').toString('base64')), /TextAsset 解码失败/);
});

function encodeTextAsset(data) {
  const source = Buffer.from(JSON.stringify(data));
  const encrypted = Buffer.allocUnsafe(source.length);
  for (let i = 0; i < source.length; i++) encrypted[i] = source[i] ^ TEXT_ASSET_KEY[i % TEXT_ASSET_KEY.length];
  return encrypted.toString('base64');
}

function writeBundleFixture(root, id, lastTime, itemName, { complete = true } = {}) {
  const cacheDir = path.join(root, APPID, 'usr', 'gamecaches');
  fs.mkdirSync(cacheDir, { recursive: true });
  const configName = `config-${id}.json`;
  const itemNameOnDisk = `item-${id}.json`;
  const plantName = `plant-${id}.json`;
  const itemUuid = `00000000-0000-0000-0000-0000000000${id.slice(-2).padStart(2, '0')}`;
  const plantUuid = `10000000-0000-0000-0000-0000000000${id.slice(-2).padStart(2, '0')}`;
  const config = {
    paths: { 0: ['config/ItemInfo'], 1: ['config/Plant'] },
    uuids: [itemUuid, plantUuid],
    versions: { import: [0, `ih-${id}`, 1, `ph-${id}`] },
  };
  fs.writeFileSync(path.join(cacheDir, configName), JSON.stringify(config));
  fs.writeFileSync(path.join(cacheDir, itemNameOnDisk), JSON.stringify([null, null, null, null, null, [[null, null, encodeTextAsset([{ id: 1, name: itemName, interaction_type: 'use' }])]]]));
  if (complete) fs.writeFileSync(path.join(cacheDir, plantName), JSON.stringify([null, null, null, null, null, [[null, null, encodeTextAsset([{ id: 1, name: `${itemName}植物`, seed_id: 20001, fruit: { id: 40001 } }])]]]));
  return {
    [`https://cdn-resource.nqf.qq.com/release/remote/mainscene/config.${id}.json`]: { url: `wxfile://usr/gamecaches/${configName}`, lastTime },
    [`https://cdn-resource.nqf.qq.com/release/remote/mainscene/import/${itemUuid.slice(0, 2)}/${itemUuid}.ih-${id}.json`]: { url: `wxfile://usr/gamecaches/${itemNameOnDisk}`, lastTime },
    ...(complete ? { [`https://cdn-resource.nqf.qq.com/release/remote/mainscene/import/${plantUuid.slice(0, 2)}/${plantUuid}.ph-${id}.json`]: { url: `wxfile://usr/gamecaches/${plantName}`, lastTime } } : {}),
  };
}

test('最新 mainscene 不完整时回退到上一个完整 bundle，且不跨 bundle 混用', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'game-data-cache-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldFiles = writeBundleFixture(root, 'old01', 100, '旧版');
  const newestFiles = writeBundleFixture(root, 'new02', 200, '新版', { complete: false });
  const cacheList = path.join(root, APPID, 'usr', 'gamecaches', 'cacheList.json');
  fs.writeFileSync(cacheList, JSON.stringify({ files: { ...oldFiles, ...newestFiles } }));
  const result = findOfficialDatasets(root);
  assert.equal(result.bundleId, 'old01');
  assert.equal(result.items[0].name, '旧版');
  assert.equal(result.plants[0].name, '旧版植物');
});
