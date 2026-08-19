export interface ActivityWindow {
    id: string;
    name?: string;
    beginTime: number;
    endTime: number;
}

export interface SellConditionContext {
    nowSec: number;
    expireTime?: number;
    activityWindows?: ReadonlyMap<string, ActivityWindow>;
    activityWindowsLoaded?: boolean;
}

interface ParsedSellCondition {
    type: string;
    value: string;
}

export function parseSellConditions(value: unknown): ParsedSellCondition[] {
    return String(value || '')
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .map((part) => {
            const separator = part.indexOf(':');
            return separator < 0
                ? { type: part, value: '' }
                : { type: part.slice(0, separator).trim(), value: part.slice(separator + 1).trim() };
        });
}

function conditionSatisfied(condition: ParsedSellCondition, context: SellConditionContext): boolean {
    const nowSec = Math.max(0, Number(context.nowSec) || 0);
    if (condition.type === '道具过期后') {
        const expireTime = Math.max(0, Number(context.expireTime) || 0);
        return expireTime > 0 && nowSec >= expireTime;
    }

    if (!context.activityWindowsLoaded || !condition.value) return false;
    const window = context.activityWindows?.get(condition.value);
    const active = Boolean(window
        && (window.beginTime <= 0 || nowSec >= window.beginTime)
        && (window.endTime <= 0 || nowSec <= window.endTime));
    if (condition.type === '活动区间外') return !active;
    if (condition.type === '活动结束后') return !window || (window.endTime > 0 && nowSec >= window.endTime);
    if (condition.type === '活动结束前') return Boolean(window && (window.endTime <= 0 || nowSec < window.endTime));
    return false;
}

function conditionKnown(condition: ParsedSellCondition, context: SellConditionContext): boolean {
    if (condition.type === '道具过期后') {
        return Math.max(0, Number(context.expireTime) || 0) > 0;
    }
    if (condition.type === '活动区间外' || condition.type === '活动结束后' || condition.type === '活动结束前') {
        return Boolean(context.activityWindowsLoaded && condition.value);
    }
    return false;
}

export function areSellConditionsKnown(value: unknown, context: SellConditionContext): boolean {
    const conditions = parseSellConditions(value);
    return conditions.length > 0 && conditions.every(condition => conditionKnown(condition, context));
}

export function isSellConditionSatisfied(value: unknown, context: SellConditionContext): boolean {
    const conditions = parseSellConditions(value);
    return conditions.length > 0
        && conditions.every(condition => conditionKnown(condition, context) && conditionSatisfied(condition, context));
}
