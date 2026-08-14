/**
 * 数据分析模块 - 作物效率分析
 */

import {
    getAllPlants,
    getFruitPrice,
    getItemImageById,
    getPlantDisplayById,
    getSeedPrice,
} from '../config/gameConfig';

export interface PlantRanking {
    id: number;
    seedId: number;
    name: string;
    seasons: number;
    level: number | null;
    growTime: number;
    growTimeStr: string;
    reduceSec: number;
    reduceSecApplied: number;
    expPerHour: number;
    normalFertilizerExpPerHour: number;
    goldPerHour: number;
    profitPerHour: number;
    normalFertilizerProfitPerHour: number;
    income: number;
    netProfit: number;
    fruitId: number;
    fruitCount: number;
    fruitPrice: number;
    seedPrice: number;
    image: string;
}

function parseGrowTime(growPhases: unknown): number {
    if (!growPhases) return 0;
    const phases = String(growPhases).split(';').filter(phase => phase.length > 0);
    let totalTime = 0;
    for (const phase of phases) {
        const match = phase.match(/:(\d+)$/);
        if (match) {
            totalTime += Number.parseInt(match[1], 10);
        }
    }
    return totalTime;
}

function parseNormalFertilizerReduceSec(growPhases: unknown): number {
    if (!growPhases) return 0;
    const phases = String(growPhases).split(';').filter(p => p.length > 0);
    if (!phases.length) return 0;
    const first = phases[0];
    const match = first.match(/:(\d+)$/);
    return match ? (Number.parseInt(match[1], 10) || 0) : 0;
}

function formatTime(seconds: number): string {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0 ? `${hours}时${mins}分` : `${hours}时`;
}

function getPlantRankings(sortBy = 'exp'): PlantRanking[] {
    const plants = getAllPlants();
    
    // 筛选普通作物
    const normalPlants = plants.filter((plant) => {
        // 放宽条件，只要有种子ID且有生长阶段数据
        return plant.seed_id > 0 && plant.grow_phases;
    });

    const results: PlantRanking[] = [];
    for (const plant of normalPlants) {
        const display = getPlantDisplayById(plant.id);
        const baseGrowTime = parseGrowTime(plant.grow_phases);
        if (baseGrowTime <= 0) continue;
        const seasons = Number(plant.seasons) || 1;
        const isTwoSeason = seasons === 2;
        const growTime = isTwoSeason ? (baseGrowTime * 1.5) : baseGrowTime;
        
        const harvestExpBase = Number.parseInt(String(plant.exp), 10) || 0;
        const harvestExp = isTwoSeason ? (harvestExpBase * 2) : harvestExpBase;
        const expPerHour = (harvestExp / growTime) * 3600;
        // 普通化肥：直接减少第一生长阶段时长（reduceSec）
        const reduceSecBase = parseNormalFertilizerReduceSec(plant.grow_phases);
        const reduceSecApplied = isTwoSeason ? (reduceSecBase * 2) : reduceSecBase;
        const fertilizedGrowTime = growTime - reduceSecApplied;
        const safeFertilizedTime = fertilizedGrowTime > 0 ? fertilizedGrowTime : 1;
        const normalFertilizerExpPerHour = (harvestExp / safeFertilizedTime) * 3600;
        
        const fruitId = Number(plant.fruit && plant.fruit.id) || 0;
        const fruitCount = Number(plant.fruit && plant.fruit.count) || 0;
        const fruitPrice = getFruitPrice(fruitId);
        const seedPrice = getSeedPrice(Number(plant.seed_id) || 0);

        // 单次收获总金币（毛收益）与净收益
        const income = (fruitCount * fruitPrice) * (isTwoSeason ? 2 : 1);
        const netProfit = income - seedPrice;
        const goldPerHour = (income / growTime) * 3600;
        const profitPerHour = (netProfit / growTime) * 3600;
        const normalFertilizerProfitPerHour = (netProfit / safeFertilizedTime) * 3600;

        const cfgLevel = Number(plant.land_level_need);
        const requiredLevel = (Number.isFinite(cfgLevel) && cfgLevel > 0) ? cfgLevel : null;
        results.push({
            id: plant.id,
            seedId: plant.seed_id,
            name: (display && display.name) || plant.name,
            seasons,
            level: requiredLevel,
            growTime,
            growTimeStr: formatTime(growTime),
            reduceSec: reduceSecBase,
            reduceSecApplied,
            expPerHour: Number.parseFloat(expPerHour.toFixed(2)),
            normalFertilizerExpPerHour: Number.parseFloat(normalFertilizerExpPerHour.toFixed(2)),
            goldPerHour: Number.parseFloat(goldPerHour.toFixed(2)), // 毛收益/时
            profitPerHour: Number.parseFloat(profitPerHour.toFixed(2)), // 净收益/时
            normalFertilizerProfitPerHour: Number.parseFloat(normalFertilizerProfitPerHour.toFixed(2)), // 普通肥净收益/时
            income,
            netProfit,
            fruitId,
            fruitCount,
            fruitPrice,
            seedPrice,
            image: getItemImageById(plant.seed_id),
        });
    }

    if (sortBy === 'exp') {
        results.sort((a, b) => b.expPerHour - a.expPerHour);
    } else if (sortBy === 'fert') {
        results.sort((a, b) => b.normalFertilizerExpPerHour - a.normalFertilizerExpPerHour);
    } else if (sortBy === 'gold') {
        results.sort((a, b) => b.goldPerHour - a.goldPerHour);
    } else if (sortBy === 'profit') {
        results.sort((a, b) => b.profitPerHour - a.profitPerHour);
    } else if (sortBy === 'fert_profit') {
        results.sort((a, b) => b.normalFertilizerProfitPerHour - a.normalFertilizerProfitPerHour);
    } else if (sortBy === 'level') {
        const lv = (value: number | null): number => value === null ? -1 : value;
        results.sort((a, b) => lv(b.level) - lv(a.level));
    }

    return results;
}

export {
    getPlantRankings,
};
