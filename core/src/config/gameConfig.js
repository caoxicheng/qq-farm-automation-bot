/**
 * 游戏配置数据模块
 * 从 gameConfig 目录加载配置数据
 */

const fs = require('node:fs');
const path = require('node:path');
const { getResourcePath } = require('./runtime-paths');
const { loadResourceBundle } = require('../game-data/resource-bundle');

// ============ 等级经验表 ============
let roleLevelConfig = null;
let levelExpTable = null;  // 累计经验表，索引为等级

// ============ 植物配置 ============
let plantConfig = null;
const plantMap = new Map();  // id -> plant
const seedToPlant = new Map();  // seed_id -> plant
const fruitToPlant = new Map();  // fruit_id -> plant (果实ID -> 植物)
let itemInfoConfig = null;
const itemInfoMap = new Map();  // item_id -> item
const seedItemMap = new Map();  // seed_id -> item(type=5)
let resourceBundle = null;

/**
 * 加载配置文件
 */
function loadConfigs() {
    const configDir = getResourcePath('gameConfig');
    
    // 加载等级经验配置
    try {
        const roleLevelPath = path.join(configDir, 'RoleLevel.json');
        if (fs.existsSync(roleLevelPath)) {
            roleLevelConfig = JSON.parse(fs.readFileSync(roleLevelPath, 'utf8'));
            // 构建累计经验表
            levelExpTable = [];
            for (const item of roleLevelConfig) {
                levelExpTable[item.level] = item.exp;
            }
            console.warn(`[配置] 已加载等级经验表 (${roleLevelConfig.length} 级)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 RoleLevel.json 失败:', e.message);
    }
    
    // 加载植物配置
    try {
        const plantPath = path.join(configDir, 'Plant.json');
        if (fs.existsSync(plantPath)) {
            plantConfig = JSON.parse(fs.readFileSync(plantPath, 'utf8'));
            plantMap.clear();
            seedToPlant.clear();
            fruitToPlant.clear();
            for (const plant of plantConfig) {
                plantMap.set(plant.id, plant);
                if (plant.seed_id) {
                    seedToPlant.set(plant.seed_id, plant);
                }
                if (plant.fruit && plant.fruit.id) {
                    fruitToPlant.set(plant.fruit.id, plant);
                }
            }
            console.warn(`[配置] 已加载植物配置 (${plantConfig.length} 种)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 Plant.json 失败:', e.message);
    }

    // 加载物品配置（含种子/果实价格）
    try {
        const itemInfoPath = path.join(configDir, 'ItemInfo.json');
        if (fs.existsSync(itemInfoPath)) {
            itemInfoConfig = JSON.parse(fs.readFileSync(itemInfoPath, 'utf8'));
            itemInfoMap.clear();
            seedItemMap.clear();
            for (const item of itemInfoConfig) {
                const id = Number(item && item.id) || 0;
                if (id <= 0) continue;
                itemInfoMap.set(id, item);
                if (Number(item.type) === 5) {
                    seedItemMap.set(id, item);
                }
            }
            console.warn(`[配置] 已加载物品配置 (${itemInfoConfig.length} 项)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 ItemInfo.json 失败:', e.message);
    }

    resourceBundle = loadResourceBundle();
    const status = resourceBundle.getBundleStatus();
    console.warn(`[配置] 已加载游戏资源包 ${status.bundleVersion} (${status.itemCount} 项, ${status.uniqueAssetCount} 图)`);
}

// ============ 等级经验相关 ============

/**
 * 获取等级经验表
 */
function getLevelExpTable() {
    return levelExpTable;
}

/**
 * 计算当前等级的经验进度
 * @param {number} level - 当前等级
 * @param {number} totalExp - 累计总经验
 * @returns {{ current: number, needed: number }} 当前等级经验进度
 */
function getLevelExpProgress(level, totalExp) {
    if (!levelExpTable || level <= 0) return { current: 0, needed: 0 };
    
    const currentLevelStart = levelExpTable[level] || 0;
    const nextLevelStart = levelExpTable[level + 1] || (currentLevelStart + 100000);
    
    const currentExp = Math.max(0, totalExp - currentLevelStart);
    const neededExp = nextLevelStart - currentLevelStart;
    
    return { current: currentExp, needed: neededExp };
}

// ============ 植物配置相关 ============

/**
 * 根据植物ID获取植物信息
 * @param {number} plantId - 植物ID
 */
function getPlantById(plantId) {
    return plantMap.get(plantId);
}

/**
 * 根据种子ID获取植物信息
 * @param {number} seedId - 种子ID
 */
function getPlantBySeedId(seedId) {
    return seedToPlant.get(seedId);
}

/**
 * 获取植物名称
 * @param {number} plantId - 植物ID
 */
function getPlantName(plantId) {
    const plant = plantMap.get(plantId);
    return plant ? plant.name : `植物${plantId}`;
}

/**
 * 根据种子ID获取植物名称
 * @param {number} seedId - 种子ID
 */
function getPlantNameBySeedId(seedId) {
    const plant = seedToPlant.get(seedId);
    return plant ? plant.name : `种子${seedId}`;
}

/**
 * 获取植物的生长时间（秒）
 * @param {number} plantId - 植物ID
 */
function getPlantGrowTime(plantId) {
    const plant = plantMap.get(plantId);
    if (!plant || !plant.grow_phases) return 0;
    
    // 解析 "种子:30;发芽:30;成熟:0;" 格式
    const phases = plant.grow_phases.split(';').filter(p => p);
    let totalSeconds = 0;
    for (const phase of phases) {
        const match = phase.match(/:(\d+)/);
        if (match) {
            totalSeconds += Number.parseInt(match[1]);
        }
    }
    return totalSeconds;
}

/**
 * 格式化时间
 * @param {number} seconds - 秒数
 */
function formatGrowTime(seconds) {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
}

/**
 * 获取植物的收获经验
 * @param {number} plantId - 植物ID
 */
function getPlantExp(plantId) {
    const plant = plantMap.get(plantId);
    return plant ? plant.exp : 0;
}

/**
 * 根据果实ID获取植物名称
 * @param {number} fruitId - 果实ID
 */
function getFruitName(fruitId) {
    const plant = fruitToPlant.get(fruitId);
    return plant ? plant.name : `果实${fruitId}`;
}

/**
 * 根据果实ID获取植物信息
 * @param {number} fruitId - 果实ID
 */
function getPlantByFruitId(fruitId) {
    return fruitToPlant.get(fruitId);
}

/**
 * 从植物ID推导种子ID（活动作物不在本地配置时的兜底）。
 * 服务端 PlantInfo.id 是植物ID（如 1020002），背包物品 id 是种子ID（如 20002），
 * 规律为 plant_id - 1000000（1x1，128/129 覆盖）；哈哈南瓜类 2x2 差 2000000。
 * 推导结果校验落在 2xxxx 种子段才返回，否则 0。
 * @param {number} plantId - 植物ID
 * @returns {number} 种子ID（推导失败返回 0）
 */
function deriveSeedIdFromPlantId(plantId) {
    const id = Number(plantId) || 0;
    if (id <= 0) return 0;
    for (const delta of [1000000, 2000000]) {
        const seedId = id - delta;
        if (seedId >= 20000 && seedId < 30000) return seedId;
    }
    return 0;
}

/**
 * 获取所有种子信息（用于备选）
 */
function getAllSeeds() {
    return Array.from(seedToPlant.values()).map(p => {
        const display = resourceBundle && resourceBundle.getPlantDisplay(p.id);
        return {
            seedId: p.seed_id,
            name: (display && display.name) || p.name,
            requiredLevel: Number(p.land_level_need) || 0,
            price: getSeedPrice(p.seed_id),
            image: getSeedImageBySeedId(p.seed_id),
        };
    });
}

function getSeedImageBySeedId(seedId) {
    const display = resourceBundle && resourceBundle.getItemDisplay(seedId);
    return (display && display.image) || '';
}

function getItemImageById(itemId) {
    const id = Number(itemId) || 0;
    if (id <= 0) return '';
    const display = resourceBundle && resourceBundle.getItemDisplay(id);
    return (display && display.image) || '';
}

function getItemById(itemId) {
    return itemInfoMap.get(Number(itemId) || 0);
}

function getItemDisplayById(itemId) {
    return resourceBundle ? resourceBundle.getItemDisplay(itemId) : null;
}

function getPlantDisplayById(plantId) {
    return resourceBundle ? resourceBundle.getPlantDisplay(plantId) : null;
}

function getSeedPrice(seedId) {
    const item = seedItemMap.get(Number(seedId) || 0);
    return item ? (Number(item.price) || 0) : 0;
}

function getFruitPrice(fruitId) {
    const item = itemInfoMap.get(Number(fruitId) || 0);
    return item ? (Number(item.price) || 0) : 0;
}

function getAllPlants() {
    return Array.from(plantMap.values());
}

// 启动时加载配置
loadConfigs();

module.exports = {
    loadConfigs,
    getAllPlants,
    getAllSeeds,
    // 等级经验
    getLevelExpTable,
    getLevelExpProgress,
    // 植物配置
    getPlantById,
    getPlantBySeedId,
    getPlantName,
    getPlantNameBySeedId,
    getPlantGrowTime,
    getPlantExp,
    formatGrowTime,
    // 果实配置
    getFruitName,
    getPlantByFruitId,
    getItemById,
    getItemDisplayById,
    getPlantDisplayById,
    getItemImageById,
    getSeedPrice,
    getFruitPrice,
    getSeedImageBySeedId,
    // 活动作物兼容（plant_id → seed_id 推导，本地配置缺失时兜底）
    deriveSeedIdFromPlantId,
};
