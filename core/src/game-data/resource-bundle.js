const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 2;

function stableJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function readJson(target) { return JSON.parse(fs.readFileSync(target, 'utf8')); }
function validRewards(rows) {
    return Array.isArray(rows) && rows.every((row) => Number.isSafeInteger(row?.id) && row.id > 0 && Number.isSafeInteger(row?.amount) && row.amount > 0);
}
function freezeSalePolicy(sale) {
    return Object.freeze({
        ...sale,
        rewards: Object.freeze((Array.isArray(sale.rewards) ? sale.rewards : []).map((reward) => Object.freeze({ ...reward }))),
        conditionalRewards: Object.freeze((Array.isArray(sale.conditionalRewards) ? sale.conditionalRewards : []).map((reward) => Object.freeze({ ...reward }))),
    });
}

class ResourceBundle {
    constructor(rootDir) {
        this.rootDir = rootDir;
        this.manifest = readJson(path.join(rootDir, 'manifest.json'));
        if (this.manifest.schemaVersion !== SCHEMA_VERSION) throw new Error(`不支持的游戏资源 schema: ${this.manifest.schemaVersion}`);
        this.items = readJson(path.join(rootDir, this.manifest.catalogs.items.file));
        this.plants = readJson(path.join(rootDir, this.manifest.catalogs.plants.file));
        if (!this.manifest.catalogs.sales) throw new Error('游戏资源包缺少 sales catalog');
        this.sales = readJson(path.join(rootDir, this.manifest.catalogs.sales.file));
        if (!Array.isArray(this.items) || !Array.isArray(this.plants) || !Array.isArray(this.sales) || !Array.isArray(this.manifest.assets.index)) throw new Error('游戏资源目录结构无效');
        if (hash(stableJson(this.items)) !== this.manifest.catalogs.items.sha256) throw new Error('游戏资源 items catalog 哈希错误');
        if (hash(stableJson(this.plants)) !== this.manifest.catalogs.plants.sha256) throw new Error('游戏资源 plants catalog 哈希错误');
        if (hash(stableJson(this.sales)) !== this.manifest.catalogs.sales.sha256) throw new Error('游戏资源 sales catalog 哈希错误');
        if (hash(stableJson(this.manifest.assets.index)) !== this.manifest.assets.indexHash) throw new Error('游戏资源图片索引哈希错误');
        this.itemMap = new Map(this.items.map((item) => [Number(item.id), Object.freeze({ ...item, price: item.price ? Object.freeze({ ...item.price }) : null })]));
        this.plantMap = new Map(this.plants.map((plant) => [Number(plant.id), Object.freeze(plant)]));
        this.saleMap = new Map(this.sales.map((sale) => [Number(sale.id), freezeSalePolicy(sale)]));
        if (this.itemMap.size !== this.items.length || this.items.length !== this.manifest.catalogs.items.count) throw new Error('游戏资源 items catalog 存在重复 ID 或数量错误');
        if (this.plantMap.size !== this.plants.length || this.plants.length !== this.manifest.catalogs.plants.count) throw new Error('游戏资源 plants catalog 存在重复 ID 或数量错误');
        if (this.saleMap.size !== this.sales.length || this.sales.length !== this.manifest.catalogs.sales.count) throw new Error('游戏资源 sales catalog 存在重复 ID 或数量错误');
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
        for (const sale of this.sales) {
            const rewards = Array.isArray(sale.rewards) ? sale.rewards : [];
            const conditionalRewards = Array.isArray(sale.conditionalRewards) ? sale.conditionalRewards : [];
            if (!Number.isSafeInteger(sale.id) || sale.id <= 0) throw new Error(`出售策略 ${sale.id} 的物品 ID 无效`);
            const item = this.itemMap.get(sale.id);
            if (!item) throw new Error(`出售策略 ${sale.id} 缺少对应物品`);
            if (![6, 17].includes(sale.itemType)) throw new Error(`出售策略 ${sale.id} 的物品类型无效`);
            if (Number(item.itemType) !== sale.itemType) throw new Error(`出售策略 ${sale.id} 的物品类型与目录不匹配`);
            if (!['available', 'conditional'].includes(sale.status)) throw new Error(`出售策略 ${sale.id} 的状态无效`);
            if (!['official', 'legacy'].includes(sale.source)) throw new Error(`出售策略 ${sale.id} 的来源无效`);
            if (!validRewards(sale.rewards) || !validRewards(sale.conditionalRewards)) throw new Error(`出售策略 ${sale.id} 的奖励无效`);
            for (const reward of [...rewards, ...conditionalRewards]) {
                if (!this.itemMap.has(reward.id)) throw new Error(`出售策略 ${sale.id} 的奖励 ${reward.id} 缺少对应物品`);
            }
            if (sale.status === 'available' && (sale.condition || rewards.length === 0)) throw new Error(`出售策略 ${sale.id} 的可售状态无效`);
            if (sale.status === 'conditional' && !sale.condition && conditionalRewards.length === 0) throw new Error(`出售策略 ${sale.id} 缺少出售条件`);
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

    getItemSalePolicy(idValue) {
        const sale = this.saleMap.get(Number(idValue) || 0);
        if (!sale) return null;
        return {
            ...sale,
            rewards: sale.rewards.map((reward) => ({ ...reward })),
            conditionalRewards: sale.conditionalRewards.map((reward) => ({ ...reward })),
        };
    }

    getAssetUrl(assetHash) {
        const value = String(assetHash || '');
        const filename = this.assetFiles.get(value);
        return filename ? `/game-assets/${filename}` : '';
    }

    getBundleStatus() {
        return { schemaVersion: this.manifest.schemaVersion, bundleVersion: this.manifest.bundleVersion, itemCount: this.items.length, plantCount: this.plants.length, salePolicyCount: this.sales.length, assetCount: this.manifest.assets.count, uniqueAssetCount: this.manifest.assets.uniqueCount };
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
