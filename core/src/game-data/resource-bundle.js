const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;

function stableJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function readJson(target) { return JSON.parse(fs.readFileSync(target, 'utf8')); }

class ResourceBundle {
    constructor(rootDir) {
        this.rootDir = rootDir;
        this.manifest = readJson(path.join(rootDir, 'manifest.json'));
        if (this.manifest.schemaVersion !== SCHEMA_VERSION) throw new Error(`不支持的游戏资源 schema: ${this.manifest.schemaVersion}`);
        this.items = readJson(path.join(rootDir, this.manifest.catalogs.items.file));
        this.plants = readJson(path.join(rootDir, this.manifest.catalogs.plants.file));
        if (!Array.isArray(this.items) || !Array.isArray(this.plants) || !Array.isArray(this.manifest.assets.index)) throw new Error('游戏资源目录结构无效');
        if (hash(stableJson(this.items)) !== this.manifest.catalogs.items.sha256) throw new Error('游戏资源 items catalog 哈希错误');
        if (hash(stableJson(this.plants)) !== this.manifest.catalogs.plants.sha256) throw new Error('游戏资源 plants catalog 哈希错误');
        if (hash(stableJson(this.manifest.assets.index)) !== this.manifest.assets.indexHash) throw new Error('游戏资源图片索引哈希错误');
        this.itemMap = new Map(this.items.map((item) => [Number(item.id), Object.freeze({ ...item, price: item.price ? Object.freeze({ ...item.price }) : null })]));
        this.plantMap = new Map(this.plants.map((plant) => [Number(plant.id), Object.freeze(plant)]));
        if (this.itemMap.size !== this.items.length || this.items.length !== this.manifest.catalogs.items.count) throw new Error('游戏资源 items catalog 存在重复 ID 或数量错误');
        if (this.plantMap.size !== this.plants.length || this.plants.length !== this.manifest.catalogs.plants.count) throw new Error('游戏资源 plants catalog 存在重复 ID 或数量错误');
        if (this.manifest.assets.index.length !== this.manifest.assets.count) throw new Error('游戏资源图片索引数量错误');
        this.assetFiles = new Map();
        for (const asset of this.manifest.assets.index) {
            const filename = `${asset.contentHash}.${asset.extension}`;
            const target = path.join(rootDir, 'assets', filename);
            if (!fs.existsSync(target)) throw new Error(`游戏资源图片缺失: ${filename}`);
            if (hash(fs.readFileSync(target)) !== asset.contentHash) throw new Error(`游戏资源图片哈希错误: ${filename}`);
            this.assetFiles.set(asset.contentHash, filename);
        }
        if (this.assetFiles.size !== this.manifest.assets.uniqueCount) throw new Error('游戏资源唯一图片数量错误');
        const relationships = new Set(this.plants.filter((plant) => plant.seedId && plant.fruitId).map((plant) => `${plant.seedId}:${plant.fruitId}`));
        for (const item of this.items) {
            if (item.imageHash && !this.assetFiles.has(item.imageHash)) throw new Error(`游戏资源物品 ${item.id} 引用了不存在的图片`);
            if (item.relatedSeedId && item.relatedFruitId && !relationships.has(`${item.relatedSeedId}:${item.relatedFruitId}`)) throw new Error(`游戏资源物品 ${item.id} 的植物关联无效`);
        }
    }

    getItemDisplay(idValue) {
        const id = Number(idValue) || 0;
        if (id <= 0) return null;
        const item = this.itemMap.get(id);
        if (item) return { ...item, price: item.price ? { ...item.price } : null, image: this.getAssetUrl(item.imageHash) };
        return { id, name: `物品 #${id}`, kind: 'unknown', itemType: null, imageHash: null, assetName: null, relatedSeedId: null, relatedFruitId: null, level: null, price: null, source: 'inferred', image: '' };
    }

    getPlantDisplay(idValue) {
        return this.plantMap.get(Number(idValue) || 0) || null;
    }

    getAssetUrl(assetHash) {
        const value = String(assetHash || '');
        const filename = this.assetFiles.get(value);
        return filename ? `/game-assets/${filename}` : '';
    }

    getBundleStatus() {
        return { schemaVersion: this.manifest.schemaVersion, bundleVersion: this.manifest.bundleVersion, itemCount: this.items.length, plantCount: this.plants.length, assetCount: this.manifest.assets.count, uniqueAssetCount: this.manifest.assets.uniqueCount };
    }
}

let currentBundle = null;

function getBundleRoot() {
    return path.join(__dirname, '..', '..', 'resources', 'game-data');
}

function loadResourceBundle() {
    currentBundle = new ResourceBundle(getBundleRoot());
    return currentBundle;
}

function getResourceBundle() {
    return currentBundle || loadResourceBundle();
}

module.exports = { ResourceBundle, getBundleRoot, getResourceBundle, loadResourceBundle };
