/**
 * 游戏配置数据模块
 * 从 gameConfig 目录加载配置数据
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    
    loadResourceBundle
    
    
    
} from '../game-data/resource-bundle';
import type {ItemDisplay, PlantDisplay, ResourceBundle, SalePolicy} from '../game-data/resource-bundle';
import { getResourcePath } from './runtime-paths';

type DataRecord = Record<string, unknown>;

interface RoleLevelEntry extends DataRecord {
    level: number;
    exp: number;
}

interface LegacyPlant extends DataRecord {
    id: number;
    seed_id: number;
    name: string;
    fruit?: { id?: number; count?: number };
    grow_phases?: string;
    exp?: number;
    land_level_need?: number;
    size?: number;
}

interface LegacyItem extends DataRecord {
    id: number;
    type?: number;
    price?: number;
}

interface SeedDisplay {
    seedId: number;
    name: string;
    requiredLevel: number;
    price: number;
    image: string;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function recordArray(value: unknown): DataRecord[] {
    return Array.isArray(value)
        ? value.filter((item): item is DataRecord => Boolean(
            item && typeof item === 'object' && !Array.isArray(item),
        ))
        : [];
}

function loadJsonRecords(filePath: string): DataRecord[] {
    return recordArray(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown);
}

// ============ 等级经验表 ============
let roleLevelConfig: RoleLevelEntry[] | null = null;
let levelExpTable: number[] | null = null;  // 累计经验表，索引为等级

// ============ 植物配置 ============
let plantConfig: LegacyPlant[] | null = null;
const plantMap = new Map<number, LegacyPlant>();  // id -> plant
const seedToPlant = new Map<number, LegacyPlant>();  // seed_id -> plant
const fruitToPlant = new Map<number, LegacyPlant>();  // fruit_id -> plant (果实ID -> 植物)
// 活动作物可能尚未进入旧版 Plant.json；这里仅补充已经由服务端行为确认的占地尺寸。
const KNOWN_PLANT_SIZE_BY_SEED_ID = new Map<number, number>([
    [29003, 2], // 星语铃花：2x2，多格请求需携带 auto_slave
]);
let itemInfoConfig: LegacyItem[] | null = null;
const itemInfoMap = new Map<number, LegacyItem>();  // item_id -> item
const seedItemMap = new Map<number, LegacyItem>();  // seed_id -> item(type=5)
let resourceBundle: ResourceBundle | null = null;

/**
 * 加载配置文件
 */
function loadConfigs(): void {
    const configDir = getResourcePath('gameConfig');
    
    // 加载等级经验配置
    try {
        const roleLevelPath = path.join(configDir, 'RoleLevel.json');
        if (fs.existsSync(roleLevelPath)) {
            roleLevelConfig = loadJsonRecords(roleLevelPath).map(item => ({
                ...item,
                level: Number(item.level) || 0,
                exp: Number(item.exp) || 0,
            }));
            // 构建累计经验表
            levelExpTable = [];
            for (const item of roleLevelConfig) {
                levelExpTable[item.level] = item.exp;
            }
            console.warn(`[配置] 已加载等级经验表 (${roleLevelConfig.length} 级)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 RoleLevel.json 失败:', errorMessage(e));
    }
    
    // 加载植物配置
    try {
        const plantPath = path.join(configDir, 'Plant.json');
        if (fs.existsSync(plantPath)) {
            plantConfig = loadJsonRecords(plantPath).map((plant) => {
                const fruit = plant.fruit && typeof plant.fruit === 'object' && !Array.isArray(plant.fruit)
                    ? plant.fruit as DataRecord
                    : null;
                return {
                    ...plant,
                    id: Number(plant.id) || 0,
                    seed_id: Number(plant.seed_id) || 0,
                    name: String(plant.name || ''),
                    ...(fruit ? { fruit: { ...fruit, id: Number(fruit.id) || 0 } } : {}),
                    ...(plant.grow_phases !== undefined ? { grow_phases: String(plant.grow_phases) } : {}),
                    ...(plant.exp !== undefined ? { exp: Number(plant.exp) || 0 } : {}),
                    ...(plant.land_level_need !== undefined
                        ? { land_level_need: Number(plant.land_level_need) || 0 }
                        : {}),
                };
            });
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
        console.warn('[配置] 加载 Plant.json 失败:', errorMessage(e));
    }

    // 加载物品配置（含种子/果实价格）
    try {
        const itemInfoPath = path.join(configDir, 'ItemInfo.json');
        if (fs.existsSync(itemInfoPath)) {
            itemInfoConfig = loadJsonRecords(itemInfoPath).map(item => ({
                ...item,
                id: Number(item.id) || 0,
                ...(item.type !== undefined ? { type: Number(item.type) || 0 } : {}),
                ...(item.price !== undefined ? { price: Number(item.price) || 0 } : {}),
            }));
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
        console.warn('[配置] 加载 ItemInfo.json 失败:', errorMessage(e));
    }

    resourceBundle = loadResourceBundle();
    const status = resourceBundle.getBundleStatus();
    console.warn(`[配置] 已加载游戏资源包 ${status.bundleVersion} (${status.itemCount} 项, ${status.uniqueAssetCount} 图)`);
}

// ============ 等级经验相关 ============

/**
 * 获取等级经验表
 */
function getLevelExpTable(): number[] | null {
    return levelExpTable;
}

/**
 * 计算当前等级的经验进度
 * @param {number} level - 当前等级
 * @param {number} totalExp - 累计总经验
 * @returns {{ current: number, needed: number }} 当前等级经验进度
 */
function getLevelExpProgress(level: number, totalExp: number): { current: number; needed: number } {
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
function getPlantById(plantId: number): LegacyPlant | undefined {
    return plantMap.get(plantId);
}

/**
 * 根据种子ID获取植物信息
 * @param {number} seedId - 种子ID
 */
function getPlantBySeedId(seedId: number): LegacyPlant | undefined {
    return seedToPlant.get(seedId);
}

/**
 * 获取种子对应的单边占地格数，并兼容未进入旧版植物表的活动种子。
 */
function getPlantSizeBySeedId(seedId: unknown, hintedSize: unknown = 0): number {
    const id = Number(seedId) || 0;
    const plant = seedToPlant.get(id);
    return Math.max(
        1,
        Number(hintedSize) || 0,
        Number(plant && plant.size) || 0,
        KNOWN_PLANT_SIZE_BY_SEED_ID.get(id) || 0,
    );
}

/**
 * 获取植物名称
 * @param {number} plantId - 植物ID
 */
function getPlantName(plantId: number): string {
    const plant = plantMap.get(plantId);
    return plant ? plant.name : `植物${plantId}`;
}

/**
 * 根据种子ID获取植物名称
 * @param {number} seedId - 种子ID
 */
function getPlantNameBySeedId(seedId: number): string {
    const plant = seedToPlant.get(seedId);
    return plant ? plant.name : `种子${seedId}`;
}

/**
 * 获取植物的生长时间（秒）
 * @param {number} plantId - 植物ID
 */
function getPlantGrowTime(plantId: number): number {
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
function formatGrowTime(seconds: number): string {
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
function getPlantExp(plantId: number): number {
    const plant = plantMap.get(plantId);
    return plant ? (Number(plant.exp) || 0) : 0;
}

/**
 * 根据果实ID获取植物名称
 * @param {number} fruitId - 果实ID
 */
function getFruitName(fruitId: number): string {
    const plant = fruitToPlant.get(fruitId);
    return plant ? plant.name : `果实${fruitId}`;
}

/**
 * 根据果实ID获取植物信息
 * @param {number} fruitId - 果实ID
 */
function getPlantByFruitId(fruitId: number): LegacyPlant | undefined {
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
function deriveSeedIdFromPlantId(plantId: unknown): number {
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
function getAllSeeds(): SeedDisplay[] {
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

function getSeedImageBySeedId(seedId: unknown): string {
    const display = resourceBundle && resourceBundle.getItemDisplay(seedId);
    return (display && display.image) || '';
}

function getItemImageById(itemId: unknown): string {
    const id = Number(itemId) || 0;
    if (id <= 0) return '';
    const display = resourceBundle && resourceBundle.getItemDisplay(id);
    return (display && display.image) || '';
}

function getItemById(itemId: unknown): LegacyItem | undefined {
    return itemInfoMap.get(Number(itemId) || 0);
}

function getItemDisplayById(itemId: unknown): ItemDisplay | null {
    return resourceBundle ? resourceBundle.getItemDisplay(itemId) : null;
}

function getItemSalePolicyById(itemId: unknown): SalePolicy | null {
    return resourceBundle ? resourceBundle.getItemSalePolicy(itemId) : null;
}

function getPlantDisplayById(plantId: unknown): PlantDisplay | null {
    return resourceBundle ? resourceBundle.getPlantDisplay(plantId) : null;
}

function getSeedPrice(seedId: unknown): number {
    const item = seedItemMap.get(Number(seedId) || 0);
    return item ? (Number(item.price) || 0) : 0;
}

function getFruitPrice(fruitId: unknown): number {
    const item = itemInfoMap.get(Number(fruitId) || 0);
    return item ? (Number(item.price) || 0) : 0;
}

function getAllPlants(): LegacyPlant[] {
    return Array.from(plantMap.values());
}

// 启动时加载配置
loadConfigs();

export {
    deriveSeedIdFromPlantId,
    formatGrowTime,
    getAllPlants,
    getAllSeeds,
    getFruitName,
    getFruitPrice,
    getItemById,
    getItemDisplayById,
    getItemImageById,
    getItemSalePolicyById,
    getLevelExpProgress,
    getLevelExpTable,
    getPlantByFruitId,
    getPlantById,
    getPlantBySeedId,
    getPlantDisplayById,
    getPlantExp,
    getPlantGrowTime,
    getPlantName,
    getPlantNameBySeedId,
    getPlantSizeBySeedId,
    getSeedImageBySeedId,
    getSeedPrice,
    loadConfigs,
};
