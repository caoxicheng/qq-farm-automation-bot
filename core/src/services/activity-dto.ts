import Long from 'long';
import { getItemById, getItemDisplayById, getItemImageById } from '../config/gameConfig';

export type ActivityRecord = Record<string, any>;

export interface ActivityItemDto {
    id: string;
    count: string;
    name: string;
    image: string;
    rarity: number;
}

export function int64String(value: unknown): string {
    if (value == null) return '0';
    if (Long.isLong(value)) return value.toString();
    if (typeof value === 'string') return /^-?\d+$/.test(value) ? value : '0';
    return Number.isSafeInteger(value) ? String(value) : '0';
}

export function int64Number(value: unknown): number {
    const parsed = Number(int64String(value));
    return Number.isSafeInteger(parsed) ? parsed : 0;
}

export function bytesToText(value: unknown): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (!(value instanceof Uint8Array)) return '';
    const buffer = Buffer.from(value);
    const utf8 = buffer.toString('utf8');
    if (!utf8.includes('\uFFFD')) return utf8;
    try {
        return new TextDecoder('gb18030').decode(buffer);
    } catch {
        return utf8;
    }
}

export function itemDto(value: unknown): ActivityItemDto {
    const item = value && typeof value === 'object' ? value as ActivityRecord : {};
    const rawId = item.item_id ?? item.itemId ?? item.id;
    const id = int64String(rawId);
    const numericId = int64Number(rawId);
    const metadata = numericId > 0 ? getItemById(numericId) : undefined;
    const display = numericId > 0 ? getItemDisplayById(numericId) : null;
    const serverName = bytesToText(item.name);
    return {
        id,
        count: int64String(item.count),
        name: display?.source !== 'inferred'
            ? String(display?.name || '')
            : String(metadata?.name || serverName || display?.name || ''),
        image: numericId > 0 ? getItemImageById(numericId) : '',
        rarity: Number(metadata?.rarity) || 0,
    };
}

export function activityDto(value: unknown, parseExtra: (extra: unknown) => unknown): ActivityRecord {
    const activity = value && typeof value === 'object' ? value as ActivityRecord : {};
    return {
        id: int64String(activity.activity_id),
        typeCode: int64String(activity.type),
        name: bytesToText(activity.name),
        startTime: int64String(activity.begin_time),
        endTime: int64String(activity.end_time),
        extra: parseExtra(activity.extra),
    };
}
