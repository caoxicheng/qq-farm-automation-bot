const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResourceBundle, getBundleRoot } = require('../src/game-data/resource-bundle');

const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

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

test('人工确认名称优先且缺少成熟图片时使用合理回退图', () => {
    const item = new ResourceBundle(getBundleRoot()).getItemDisplay(49003);
    assert.equal(item.name, '梅酒果实');
    assert.equal(item.source, 'override');
    assert.match(item.image, /^\/game-assets\/[a-f0-9]{64}\.png$/);
});

test('未知物品不猜名并保持稳定回退', () => {
    const item = new ResourceBundle(getBundleRoot()).getItemDisplay(999999);
    assert.equal(item.name, '物品 #999999');
    assert.equal(item.kind, 'unknown');
    assert.equal(item.image, '');
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
        schemaVersion: 1,
        bundleVersion: 'fixture',
        catalogs: {
            items: { file: 'catalogs/items.json', sha256: hash(stableJson(items)), count: 0 },
            plants: { file: 'catalogs/plants.json', sha256: hash(stableJson(plants)), count: 0 },
        },
        assets: { count: 1, uniqueCount: 1, indexHash: hash(stableJson(index)), index },
    };
    fs.writeFileSync(path.join(root, 'catalogs', 'items.json'), stableJson(items));
    fs.writeFileSync(path.join(root, 'catalogs', 'plants.json'), stableJson(plants));
    fs.writeFileSync(path.join(root, 'manifest.json'), stableJson(manifest));
    fs.writeFileSync(path.join(root, 'assets', `${contentHash}.png`), 'tampered');
    assert.throws(() => new ResourceBundle(root), /图片哈希错误/);
});
