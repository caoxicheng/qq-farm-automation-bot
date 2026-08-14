const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResourceBundle, getBundleRoot } = require('../src/game-data/resource-bundle');

const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function writeCatalogFixture(root, { sales = [], includeSales = true, salesHash = null } = {}) {
    const items = [
        { id: 1001, name: '金币', kind: 'currency', itemType: 1, imageHash: null },
        { id: 1005, name: '金豆豆', kind: 'currency', itemType: 1, imageHash: null },
        { id: 49003, name: '星语铃花', kind: 'fruit', itemType: 6, imageHash: null },
    ];
    const plants = [];
    fs.mkdirSync(path.join(root, 'catalogs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    const catalogs: Record<string, any> = {
        items: { file: 'catalogs/items.json', sha256: hash(stableJson(items)), count: items.length },
        plants: { file: 'catalogs/plants.json', sha256: hash(stableJson(plants)), count: plants.length },
    };
    if (includeSales) catalogs.sales = { file: 'catalogs/sales.json', sha256: salesHash || hash(stableJson(sales)), count: sales.length };
    const manifest = {
        schemaVersion: 2,
        bundleVersion: 'fixture',
        catalogs,
        assets: { count: 0, uniqueCount: 0, indexHash: hash(stableJson([])), index: [] },
    };
    fs.writeFileSync(path.join(root, 'catalogs', 'items.json'), stableJson(items));
    fs.writeFileSync(path.join(root, 'catalogs', 'plants.json'), stableJson(plants));
    if (includeSales) fs.writeFileSync(path.join(root, 'catalogs', 'sales.json'), stableJson(sales));
    fs.writeFileSync(path.join(root, 'manifest.json'), stableJson(manifest));
}

test('发布资源包补全截图中的官方名称和图片', () => {
    const bundle = new ResourceBundle(getBundleRoot());
    const expected = new Map([
        [41380, '梧桐'], [41037, '银星海棠'], [41404, '月光花'], [46032, '月见草'], [41221, '青梅'],
    ]);
    for (const [id, name] of expected) {
        const item = bundle.getItemDisplay(id);
        assert.equal(item.name, name);
        assert.equal(item.kind, 'fruit');
        assert.match(item.image, /^\/game-assets\/[a-f0-9]{64}\.[a-z0-9]+$/);
    }
});

test('当前官方星语铃花名称覆盖过期活动称呼', () => {
    const bundle = new ResourceBundle(getBundleRoot());
    const seed = bundle.getItemDisplay(29003);
    const fruit = bundle.getItemDisplay(49003);
    const superFruit = bundle.getItemDisplay(1049003);
    assert.deepEqual([seed.name, fruit.name, superFruit.name], ['星语铃花种子', '星语铃花', '黄金·星语铃花']);
    assert.deepEqual([seed.source, fruit.source, superFruit.source], ['official', 'official', 'official']);
    assert.match(fruit.image, /^\/game-assets\/[a-f0-9]{64}\.png$/);
    assert.equal(superFruit.image, fruit.image);
});

test('缺少独立素材的超变果实回退到同作物成熟果实图', () => {
    const bundle = new ResourceBundle(getBundleRoot());
    const pairs = [
        [1040108, 40108], [1040184, 40184], [1040185, 40185], [1040256, 40256],
        [1040261, 40261], [1040264, 40264], [1041037, 41037], [1041050, 41050],
        [1041221, 41221], [1041251, 41251], [1041380, 41380], [1041404, 41404],
        [1046032, 46032], [1049003, 49003],
    ];
    for (const [superFruitId, fruitId] of pairs) {
        const superFruit = bundle.getItemDisplay(superFruitId);
        const fruit = bundle.getItemDisplay(fruitId);
        assert.match(superFruit.image, /^\/game-assets\/[a-f0-9]{64}\.png$/);
        assert.equal(superFruit.image, fruit.image);
    }
});

test('已有独立素材的超变果实优先使用自身图片', () => {
    const item = new ResourceBundle(getBundleRoot()).getItemDisplay(1040046);
    assert.match(item.image, new RegExp(`/game-assets/${item.imageHash}\\.png$`));
});

test('资源包提供独立的普通果实和超变果实出售策略', () => {
    const bundle = new ResourceBundle(getBundleRoot());
    assert.deepEqual(bundle.getItemSalePolicy(49003), {
        id: 49003,
        itemType: 6,
        status: 'available',
        rewards: [{ id: 1001, amount: 320 }],
        condition: null,
        conditionalRewards: [],
        source: 'official',
    });
    assert.deepEqual(bundle.getItemSalePolicy(1049003), {
        id: 1049003,
        itemType: 17,
        status: 'available',
        rewards: [{ id: 1005, amount: 30 }],
        condition: null,
        conditionalRewards: [],
        source: 'official',
    });
});

test('未知物品不猜名并保持稳定回退', () => {
    const item = new ResourceBundle(getBundleRoot()).getItemDisplay(999999);
    assert.equal(item.name, '物品 #999999');
    assert.equal(item.kind, 'unknown');
    assert.equal(item.image, '');
});

test('资源清单中的目录越界路径会被拒绝', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-bundle-path-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeCatalogFixture(root);
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.catalogs.items.file = '../outside.json';
    fs.writeFileSync(manifestPath, stableJson(manifest));
    assert.throws(() => new ResourceBundle(root), /资源路径越界/);
});

test('损坏的图片内容会阻止资源包加载', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-bundle-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'catalogs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    const items = [];
    const plants = [];
    const contentHash = hash('expected');
    const index = [{ id: 1, assetName: null, variant: 'other', contentHash, extension: 'png', originalName: 'fixture.png', sourceHash: null }];
    const manifest = {
        schemaVersion: 2,
        bundleVersion: 'fixture',
        catalogs: {
            items: { file: 'catalogs/items.json', sha256: hash(stableJson(items)), count: 0 },
            plants: { file: 'catalogs/plants.json', sha256: hash(stableJson(plants)), count: 0 },
            sales: { file: 'catalogs/sales.json', sha256: hash(stableJson([])), count: 0 },
        },
        assets: { count: 1, uniqueCount: 1, indexHash: hash(stableJson(index)), index },
    };
    fs.writeFileSync(path.join(root, 'catalogs', 'items.json'), stableJson(items));
    fs.writeFileSync(path.join(root, 'catalogs', 'plants.json'), stableJson(plants));
    fs.writeFileSync(path.join(root, 'catalogs', 'sales.json'), stableJson([]));
    fs.writeFileSync(path.join(root, 'manifest.json'), stableJson(manifest));
    fs.writeFileSync(path.join(root, 'assets', `${contentHash}.png`), 'tampered');
    assert.throws(() => new ResourceBundle(root), /图片哈希错误/);
});

test('缺失或损坏的出售策略会阻止资源包加载', (t) => {
    const cases = [
        { name: '缺少 sales catalog', options: { includeSales: false }, error: /缺少 sales catalog/ },
        { name: 'sales catalog 哈希错误', options: { salesHash: '0'.repeat(64) }, error: /sales catalog 哈希错误/ },
        {
            name: '重复 ID',
            options: { sales: [
                { id: 49003, itemType: 6, status: 'available', rewards: [{ id: 1001, amount: 320 }], condition: null, conditionalRewards: [], source: 'official' },
                { id: 49003, itemType: 6, status: 'available', rewards: [{ id: 1001, amount: 320 }], condition: null, conditionalRewards: [], source: 'official' },
            ] },
            error: /重复 ID 或数量错误/,
        },
        {
            name: '非法类型',
            options: { sales: [{ id: 49003, itemType: 5, status: 'available', rewards: [{ id: 1001, amount: 320 }], condition: null, conditionalRewards: [], source: 'official' }] },
            error: /物品类型无效/,
        },
        {
            name: '目录类型不匹配',
            options: { sales: [{ id: 49003, itemType: 17, status: 'available', rewards: [{ id: 1005, amount: 30 }], condition: null, conditionalRewards: [], source: 'official' }] },
            error: /物品类型与目录不匹配/,
        },
        {
            name: '奖励引用不存在',
            options: { sales: [{ id: 49003, itemType: 6, status: 'available', rewards: [{ id: 999999, amount: 1 }], condition: null, conditionalRewards: [], source: 'official' }] },
            error: /奖励 999999 缺少对应物品/,
        },
        {
            name: '非法奖励',
            options: { sales: [{ id: 49003, itemType: 6, status: 'available', rewards: [{ id: 1001, amount: -1 }], condition: null, conditionalRewards: [], source: 'official' }] },
            error: /奖励无效/,
        },
    ];
    for (const row of cases) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-bundle-sales-test-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        writeCatalogFixture(root, row.options);
        assert.throws(() => new ResourceBundle(root), row.error, row.name);
    }
});
export {};
