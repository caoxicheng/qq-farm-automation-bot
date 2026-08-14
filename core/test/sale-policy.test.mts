/* eslint-disable test/no-import-node-test -- Node 内置测试运行器 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { getCoreRoot } = require('../src/config/runtime-paths.js');
const gameDataLibUrl = pathToFileURL(path.join(getCoreRoot(), '..', 'scripts', 'game-data', 'lib.mjs')).href;
const { buildCatalogs, buildSalePolicies, findUnparsedSaleItemIds, parseSaleRewards } = await import(gameDataLibUrl);

test('出售奖励支持多奖励并合并重复货币', () => {
  assert.deepEqual(parseSaleRewards('1005:30;1017:10;1005:20', 1049003), [
    { id: 1005, amount: 50 },
    { id: 1017, amount: 10 },
  ]);
  assert.throws(() => parseSaleRewards('1005:0', 1049003), /奖励数值无效/);
  assert.throws(() => parseSaleRewards('invalid', 1049003), /奖励格式无效/);
});

test('官方出售策略优先于旧配置并保留条件奖励', () => {
  const policies = buildSalePolicies({
    officialItems: [
      { id: 49003, type: 6, sells: '1001:320' },
      { id: 1049003, type: 17, sells: '1005:30' },
      { id: 41221, type: 6, sell_cond: 'activity:2026081202', cond_sells: '1001:80;1002:1' },
    ],
    legacyItems: [
      { id: 49003, type: 6, price_id: 1001, price: 1 },
      { id: 40002, type: 6, price_id: 1001, price: 2 },
    ],
  });
  assert.deepEqual(policies, [
    { id: 40002, itemType: 6, status: 'available', rewards: [{ id: 1001, amount: 2 }], condition: null, conditionalRewards: [], source: 'legacy' },
    { id: 41221, itemType: 6, status: 'conditional', rewards: [], condition: 'activity:2026081202', conditionalRewards: [{ id: 1001, amount: 80 }, { id: 1002, amount: 1 }], source: 'official' },
    { id: 49003, itemType: 6, status: 'available', rewards: [{ id: 1001, amount: 320 }], condition: null, conditionalRewards: [], source: 'official' },
    { id: 1049003, itemType: 17, status: 'available', rewards: [{ id: 1005, amount: 30 }], condition: null, conditionalRewards: [], source: 'official' },
  ]);
});

test('展示 override 不能单独生成出售权限', () => {
  const catalogs = buildCatalogs({
    officialItems: [],
    officialPlants: [],
    legacyItems: [],
    overrides: [{ id: 49999, name: '人工展示名', evidence: 'fixture' }],
    assets: [],
  });
  assert.equal(catalogs.items[0].name, '人工展示名');
  assert.deepEqual(catalogs.sales, []);
});

test('未生成策略的果实会进入无法解析售价报告', () => {
  const officialItems = [
    { id: 20002, type: 5 },
    { id: 49003, type: 6 },
    { id: 1049003, type: 17, sells: '1005:30' },
  ];
  const legacyItems = [
    { id: 49003, type: 6, price: 320 },
    { id: 40002, type: 6, price: 2 },
  ];
  const sales = buildSalePolicies({ officialItems, legacyItems });
  assert.deepEqual(findUnparsedSaleItemIds({ officialItems, legacyItems, sales }), [49003]);
});
export {};
