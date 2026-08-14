import { toNum } from '../utils/utils';

export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : {};
}

export function recordArray(value: unknown): UnknownRecord[] {
    return Array.isArray(value)
        ? value.filter((item): item is UnknownRecord => Boolean(
            item && typeof item === 'object' && !Array.isArray(item),
        ))
        : [];
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function getLocalDateKey(date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function formatRewardSummary(items: unknown): string {
    const summary: string[] = [];
    for (const item of recordArray(items)) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (count <= 0) continue;
        if (id === 1 || id === 1001) summary.push(`金币${count}`);
        else if (id === 2 || id === 1101) summary.push(`经验${count}`);
        else if (id === 1002) summary.push(`点券${count}`);
        else summary.push(`物品#${id}x${count}`);
    }
    return summary.join('/');
}
