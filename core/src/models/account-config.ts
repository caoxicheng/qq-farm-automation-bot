type UnknownRecord = Record<string, unknown>;

export interface AutoReloginConfig {
    enabled: boolean;
    delayMinutes: number;
    maxPerDay: number;
    kickWindowMinutes: number;
    loginFailWindowSec: number;
}

export interface FriendQuietHoursConfig {
    enabled: boolean;
    start: string;
    end: string;
}

export interface OfflineReminderConfig {
    channel: string;
    reloginUrlMode: string;
    endpoint: string;
    token: string;
    title: string;
    msg: string;
    offlineDeleteSec: number;
}

export interface AccountConfig extends UnknownRecord {
    automation: UnknownRecord;
    plantingStrategy: string;
    preferredSeedId: number;
    intervals: Record<string, number>;
    friendQuietHours: FriendQuietHoursConfig;
    knownFriendGids: number[];
    knownFriendGidSyncCooldownSec: number;
    friendsListCacheTtlSec: number;
    friendBlacklist: number[];
    plantBlacklist: number[];
    stealDelaySeconds: number;
    plantOrderRandom: boolean;
    plantDelaySeconds: number;
    fertilizerBuyOrganicCount: number;
    fertilizerBuyOrganicThresholdHours: number;
    fertilizerBuyNormalCount: number;
    fertilizerBuyNormalThresholdHours: number;
    fertilizerBuyCheckIntervalMinutes: number;
    bagSeedPriority: number[];
    bagSeedFallbackStrategy: string;
    autoRelogin: AutoReloginConfig;
}

export const ALLOWED_PLANTING_STRATEGIES = [
    'preferred',
    'level',
    'max_exp',
    'max_fert_exp',
    'max_profit',
    'max_fert_profit',
    'bag_priority',
];

const ALLOWED_BAG_SEED_FALLBACK_STRATEGIES = ALLOWED_PLANTING_STRATEGIES.filter(
    strategy => strategy !== 'bag_priority',
);
const PUSHOO_CHANNELS = new Set([
    'webhook', 'qmsg', 'serverchan', 'pushplus', 'pushplushxtrip',
    'dingtalk', 'wecom', 'bark', 'gocqhttp', 'onebot', 'atri',
    'pushdeer', 'igot', 'telegram', 'feishu', 'ifttt', 'wecombot',
    'discord', 'wxpusher',
]);

export const DEFAULT_FERTILIZER_LAND_TYPES = ['gold', 'black', 'red', 'normal'];
const FERTILIZER_LAND_TYPE_SET = new Set(DEFAULT_FERTILIZER_LAND_TYPES);
const INTERVAL_MAX_SEC = 86400;
export const DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC = 300;
export const DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC = 60;

export const DEFAULT_OFFLINE_REMINDER: OfflineReminderConfig = {
    channel: 'webhook',
    reloginUrlMode: 'none',
    endpoint: '',
    token: '',
    title: '账号下线提醒',
    msg: '账号下线',
    offlineDeleteSec: 0,
};

export const DEFAULT_ACCOUNT_CONFIG: AccountConfig = {
    automation: {
        farm: true,
        farm_push: true,
        land_upgrade: false,
        friend: true,
        friend_help_exp_limit: true,
        friend_steal: true,
        friend_help: true,
        friend_bad: false,
        task: true,
        fertilizer_gift: false,
        fertilizer_buy_organic: false,
        fertilizer_buy_normal: false,
        sell: false,
        mystery_shop_buy: false,
        fertilizer: 'smart',
        fertilizer_multi_season: true,
        fertilizer_land_types: [...DEFAULT_FERTILIZER_LAND_TYPES],
        fertilizer_smart_seconds: 300,
        skip_own_weed_bug: true,
    },
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    intervals: {
        farm: 2,
        farmMin: 20,
        farmMax: 25,
        helpMin: 20,
        helpMax: 25,
        stealMin: 20,
        stealMax: 25,
    },
    friendQuietHours: {
        enabled: false,
        start: '01:00',
        end: '07:30',
    },
    knownFriendGids: [],
    knownFriendGidSyncCooldownSec: DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    friendsListCacheTtlSec: DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
    friendBlacklist: [],
    plantBlacklist: [20002, 20003, 20059, 20065, 20064, 20060, 20061],
    stealDelaySeconds: 1,
    plantOrderRandom: true,
    plantDelaySeconds: 2,
    fertilizerBuyOrganicCount: 1,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 1,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 60,
    bagSeedPriority: [],
    bagSeedFallbackStrategy: 'level',
    autoRelogin: {
        enabled: false,
        delayMinutes: 15,
        maxPerDay: 3,
        kickWindowMinutes: 10,
        loginFailWindowSec: 60,
    },
};

const ALLOWED_AUTOMATION_KEYS = new Set(Object.keys(DEFAULT_ACCOUNT_CONFIG.automation));

function asRecord(value: unknown): UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : {};
}

function parseInteger(value: unknown): number {
    return Number.parseInt(String(value), 10);
}

export function normalizeKnownFriendGids(input: unknown, fallback: readonly unknown[] = []): number[] {
    const source = Array.isArray(input) ? input : fallback;
    const normalized: number[] = [];
    for (const item of source) {
        const value = parseInteger(item);
        if (!Number.isFinite(value) || value <= 0) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

export function normalizeKnownFriendGidSyncCooldownSec(
    input: unknown,
    fallback = DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
): number {
    const value = parseInteger(input);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(30, Math.min(INTERVAL_MAX_SEC, base));
}

export function normalizeFriendsListCacheTtlSec(
    input: unknown,
    fallback = DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
): number {
    const value = parseInteger(input);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(10, Math.min(INTERVAL_MAX_SEC, base));
}

export function normalizeBagSeedPriority(input: unknown): number[] {
    if (!Array.isArray(input)) return [];
    const normalized: number[] = [];
    for (const item of input) {
        const value = parseInteger(item);
        if (!Number.isFinite(value) || value <= 0) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

export function normalizeBagSeedFallbackStrategy(input: unknown, fallback = 'level'): string {
    const strategy = String(input || '').trim();
    if (ALLOWED_BAG_SEED_FALLBACK_STRATEGIES.includes(strategy)) return strategy;
    return fallback;
}

export function normalizeOfflineReminder(input: unknown): OfflineReminderConfig {
    const source = asRecord(input);
    let offlineDeleteSec = parseInteger(source.offlineDeleteSec);
    if (!Number.isFinite(offlineDeleteSec) || offlineDeleteSec < 0) {
        offlineDeleteSec = DEFAULT_OFFLINE_REMINDER.offlineDeleteSec;
    }
    const rawChannel = source.channel !== undefined && source.channel !== null
        ? String(source.channel).trim().toLowerCase()
        : '';
    const endpoint = source.endpoint !== undefined && source.endpoint !== null
        ? String(source.endpoint).trim()
        : DEFAULT_OFFLINE_REMINDER.endpoint;
    const migratedChannel = rawChannel
        || (PUSHOO_CHANNELS.has(String(endpoint || '').trim().toLowerCase())
            ? String(endpoint || '').trim().toLowerCase()
            : DEFAULT_OFFLINE_REMINDER.channel);
    const channel = PUSHOO_CHANNELS.has(migratedChannel)
        ? migratedChannel
        : DEFAULT_OFFLINE_REMINDER.channel;
    const rawReloginUrlMode = source.reloginUrlMode !== undefined && source.reloginUrlMode !== null
        ? String(source.reloginUrlMode).trim().toLowerCase()
        : DEFAULT_OFFLINE_REMINDER.reloginUrlMode;
    const reloginUrlMode = new Set(['none', 'qq_link', 'qr_link']).has(rawReloginUrlMode)
        ? rawReloginUrlMode
        : DEFAULT_OFFLINE_REMINDER.reloginUrlMode;
    return {
        channel,
        reloginUrlMode,
        endpoint,
        token: source.token !== undefined && source.token !== null
            ? String(source.token).trim()
            : DEFAULT_OFFLINE_REMINDER.token,
        title: source.title !== undefined && source.title !== null
            ? String(source.title).trim()
            : DEFAULT_OFFLINE_REMINDER.title,
        msg: source.msg !== undefined && source.msg !== null
            ? String(source.msg).trim()
            : DEFAULT_OFFLINE_REMINDER.msg,
        offlineDeleteSec,
    };
}

export function normalizeFertilizerLandTypes(
    input: unknown,
    fallback: readonly unknown[] = DEFAULT_FERTILIZER_LAND_TYPES,
): string[] {
    const source = Array.isArray(input) ? input : fallback;
    const normalized: string[] = [];
    for (const item of source) {
        const value = String(item || '').trim().toLowerCase();
        if (!FERTILIZER_LAND_TYPE_SET.has(value)) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

export function normalizeIntervals(intervals: unknown): Record<string, number> {
    const source = asRecord(intervals);
    const toSec = (value: unknown, fallback: number) => Math.max(1, parseInteger(value) || fallback);
    const farm = toSec(source.farm, 2);
    let farmMin = toSec(source.farmMin, farm);
    let farmMax = toSec(source.farmMax, farm);
    if (farmMin > farmMax) [farmMin, farmMax] = [farmMax, farmMin];
    let helpMin = toSec(source.helpMin, 10);
    let helpMax = toSec(source.helpMax, 10);
    if (helpMin > helpMax) [helpMin, helpMax] = [helpMax, helpMin];
    let stealMin = toSec(source.stealMin, 10);
    let stealMax = toSec(source.stealMax, 10);
    if (stealMin > stealMax) [stealMin, stealMax] = [stealMax, stealMin];
    const passthrough: Record<string, number> = {};
    for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'number') passthrough[key] = value;
    }
    return { ...passthrough, farm, farmMin, farmMax, helpMin, helpMax, stealMin, stealMax };
}

export function normalizeTimeString(value: unknown, fallback: string): string {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{1,2})$/);
    if (!match) return fallback;
    const hours = Math.max(0, Math.min(23, parseInteger(match[1])));
    const minutes = Math.max(0, Math.min(59, parseInteger(match[2])));
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function normalizeAutoRelogin(input: unknown, fallback?: unknown): AutoReloginConfig {
    const source = asRecord(input);
    const defaults = asRecord(fallback || DEFAULT_ACCOUNT_CONFIG.autoRelogin);
    const numberInRange = (value: unknown, defaultValue: number, min: number, max: number) => {
        const parsed = parseInteger(value);
        if (!Number.isFinite(parsed)) return defaultValue;
        return Math.max(min, Math.min(max, parsed));
    };
    return {
        enabled: source.enabled !== undefined ? Boolean(source.enabled) : Boolean(defaults.enabled),
        delayMinutes: numberInRange(source.delayMinutes, Number(defaults.delayMinutes) || 15, 1, 1440),
        maxPerDay: numberInRange(source.maxPerDay, Number(defaults.maxPerDay) || 3, 1, 100),
        kickWindowMinutes: numberInRange(source.kickWindowMinutes, Number(defaults.kickWindowMinutes) || 10, 1, 1440),
        loginFailWindowSec: numberInRange(source.loginFailWindowSec, Number(defaults.loginFailWindowSec) || 60, 5, 3600),
    };
}

export function cloneAccountConfig(base: unknown = DEFAULT_ACCOUNT_CONFIG): AccountConfig {
    const source = asRecord(base);
    const sourceAutomation = asRecord(source.automation);
    const automation: UnknownRecord = { ...DEFAULT_ACCOUNT_CONFIG.automation };
    for (const key of Object.keys(automation)) {
        if (key === 'fertilizer_land_types') {
            automation[key] = normalizeFertilizerLandTypes(
                sourceAutomation[key],
                DEFAULT_FERTILIZER_LAND_TYPES,
            );
        } else if (sourceAutomation[key] !== undefined) {
            automation[key] = sourceAutomation[key];
        }
    }
    const rawBlacklist = Array.isArray(source.friendBlacklist) ? source.friendBlacklist : [];
    const rawPlantBlacklist = Array.isArray(source.plantBlacklist) ? source.plantBlacklist : [];
    const intervals = Object.keys(asRecord(source.intervals)).length > 0
        ? asRecord(source.intervals)
        : DEFAULT_ACCOUNT_CONFIG.intervals;
    const quietHours = Object.keys(asRecord(source.friendQuietHours)).length > 0
        ? asRecord(source.friendQuietHours)
        : DEFAULT_ACCOUNT_CONFIG.friendQuietHours;
    return {
        ...source,
        automation,
        intervals: Object.fromEntries(
            Object.entries(intervals).map(([key, value]) => [key, Number(value)]),
        ),
        friendQuietHours: {
            enabled: Boolean(quietHours.enabled),
            start: String(quietHours.start || ''),
            end: String(quietHours.end || ''),
        },
        autoRelogin: normalizeAutoRelogin(source.autoRelogin, DEFAULT_ACCOUNT_CONFIG.autoRelogin),
        knownFriendGids: normalizeKnownFriendGids(source.knownFriendGids),
        knownFriendGidSyncCooldownSec: normalizeKnownFriendGidSyncCooldownSec(source.knownFriendGidSyncCooldownSec),
        friendsListCacheTtlSec: normalizeFriendsListCacheTtlSec(source.friendsListCacheTtlSec),
        friendBlacklist: rawBlacklist.map(Number).filter(value => Number.isFinite(value) && value > 0),
        plantingStrategy: ALLOWED_PLANTING_STRATEGIES.includes(String(source.plantingStrategy || ''))
            ? String(source.plantingStrategy)
            : DEFAULT_ACCOUNT_CONFIG.plantingStrategy,
        preferredSeedId: Math.max(0, parseInteger(source.preferredSeedId) || 0),
        plantBlacklist: rawPlantBlacklist.map(Number).filter(value => Number.isFinite(value) && value > 0),
        stealDelaySeconds: Math.max(0, Math.min(300, Number(source.stealDelaySeconds) || 0)),
        plantOrderRandom: Boolean(source.plantOrderRandom),
        plantDelaySeconds: Math.max(0, Math.min(60, Number(source.plantDelaySeconds) || 0)),
        fertilizerBuyOrganicCount: Math.max(0, Math.min(10000, Number(source.fertilizerBuyOrganicCount) || 0)),
        fertilizerBuyOrganicThresholdHours: Math.max(0, Math.min(990, Number(source.fertilizerBuyOrganicThresholdHours) || 0)),
        fertilizerBuyNormalCount: Math.max(0, Math.min(10000, Number(source.fertilizerBuyNormalCount) || 0)),
        fertilizerBuyNormalThresholdHours: Math.max(0, Math.min(990, Number(source.fertilizerBuyNormalThresholdHours) || 0)),
        fertilizerBuyCheckIntervalMinutes: Math.max(1, Math.min(1440, Number(source.fertilizerBuyCheckIntervalMinutes) || 30)),
        bagSeedPriority: normalizeBagSeedPriority(source.bagSeedPriority),
        bagSeedFallbackStrategy: normalizeBagSeedFallbackStrategy(source.bagSeedFallbackStrategy),
    };
}

export function normalizeAccountConfig(input: unknown, fallback: unknown = DEFAULT_ACCOUNT_CONFIG): AccountConfig {
    const source = asRecord(input);
    const config = cloneAccountConfig(fallback || DEFAULT_ACCOUNT_CONFIG);
    const sourceAutomation = asRecord(source.automation);
    for (const [key, value] of Object.entries(sourceAutomation)) {
        if (!ALLOWED_AUTOMATION_KEYS.has(key)) continue;
        if (key === 'fertilizer') {
            const allowed = ['both', 'normal', 'organic', 'smart', 'none'];
            config.automation[key] = typeof value === 'string' && allowed.includes(value)
                ? value
                : config.automation[key];
        } else if (key === 'fertilizer_land_types') {
            config.automation[key] = normalizeFertilizerLandTypes(value, config.automation[key] as unknown[]);
        } else if (key === 'fertilizer_smart_seconds') {
            config.automation[key] = Math.max(30, Math.min(3600, Number(value) || 300));
        } else {
            config.automation[key] = Boolean(value);
        }
    }
    if (typeof source.plantingStrategy === 'string' && ALLOWED_PLANTING_STRATEGIES.includes(source.plantingStrategy)) {
        config.plantingStrategy = source.plantingStrategy;
    }
    if (source.preferredSeedId !== undefined && source.preferredSeedId !== null) {
        config.preferredSeedId = Math.max(0, parseInteger(source.preferredSeedId) || 0);
    }
    const sourceIntervals = asRecord(source.intervals);
    if (Object.keys(sourceIntervals).length > 0) {
        for (const [type, seconds] of Object.entries(sourceIntervals)) {
            if (config.intervals[type] === undefined) continue;
            config.intervals[type] = Math.max(1, parseInteger(seconds) || config.intervals[type] || 1);
        }
    }
    config.intervals = normalizeIntervals(config.intervals);
    const sourceQuietHours = asRecord(source.friendQuietHours);
    if (Object.keys(sourceQuietHours).length > 0) {
        const current = config.friendQuietHours;
        config.friendQuietHours = {
            enabled: sourceQuietHours.enabled !== undefined ? Boolean(sourceQuietHours.enabled) : current.enabled,
            start: normalizeTimeString(sourceQuietHours.start, current.start || '23:00'),
            end: normalizeTimeString(sourceQuietHours.end, current.end || '07:00'),
        };
    }
    const sourceAutoRelogin = asRecord(source.autoRelogin);
    if (Object.keys(sourceAutoRelogin).length > 0) {
        const current = config.autoRelogin;
        config.autoRelogin = normalizeAutoRelogin({
            enabled: sourceAutoRelogin.enabled !== undefined ? Boolean(sourceAutoRelogin.enabled) : current.enabled,
            delayMinutes: sourceAutoRelogin.delayMinutes ?? current.delayMinutes,
            maxPerDay: sourceAutoRelogin.maxPerDay ?? current.maxPerDay,
            kickWindowMinutes: sourceAutoRelogin.kickWindowMinutes ?? current.kickWindowMinutes,
            loginFailWindowSec: sourceAutoRelogin.loginFailWindowSec ?? current.loginFailWindowSec,
        }, current);
    }
    if (Array.isArray(source.friendBlacklist)) {
        config.friendBlacklist = source.friendBlacklist.map(Number).filter(value => Number.isFinite(value) && value > 0);
    }
    if (source.knownFriendGids !== undefined) {
        config.knownFriendGids = normalizeKnownFriendGids(source.knownFriendGids, config.knownFriendGids);
    }
    if (source.knownFriendGidSyncCooldownSec !== undefined) {
        config.knownFriendGidSyncCooldownSec = normalizeKnownFriendGidSyncCooldownSec(
            source.knownFriendGidSyncCooldownSec,
            config.knownFriendGidSyncCooldownSec,
        );
    }
    if (source.friendsListCacheTtlSec !== undefined) {
        config.friendsListCacheTtlSec = normalizeFriendsListCacheTtlSec(
            source.friendsListCacheTtlSec,
            config.friendsListCacheTtlSec,
        );
    }
    if (Array.isArray(source.plantBlacklist)) {
        config.plantBlacklist = source.plantBlacklist.map(Number).filter(value => Number.isFinite(value) && value > 0);
    }
    if (source.stealDelaySeconds !== undefined && source.stealDelaySeconds !== null) {
        config.stealDelaySeconds = Math.max(0, Math.min(300, parseInteger(source.stealDelaySeconds) || 0));
    }
    if (source.plantOrderRandom !== undefined && source.plantOrderRandom !== null) {
        config.plantOrderRandom = Boolean(source.plantOrderRandom);
    }
    if (source.plantDelaySeconds !== undefined && source.plantDelaySeconds !== null) {
        config.plantDelaySeconds = Math.max(0, Math.min(60, Number(source.plantDelaySeconds) || 0));
    }
    if (source.fertilizerBuyOrganicCount !== undefined && source.fertilizerBuyOrganicCount !== null) {
        config.fertilizerBuyOrganicCount = Math.max(0, Math.min(10000, Number(source.fertilizerBuyOrganicCount) || 0));
    }
    if (source.fertilizerBuyOrganicThresholdHours !== undefined && source.fertilizerBuyOrganicThresholdHours !== null) {
        config.fertilizerBuyOrganicThresholdHours = Math.max(0, Math.min(990, Number(source.fertilizerBuyOrganicThresholdHours) || 0));
    }
    if (source.fertilizerBuyNormalCount !== undefined && source.fertilizerBuyNormalCount !== null) {
        config.fertilizerBuyNormalCount = Math.max(0, Math.min(10000, Number(source.fertilizerBuyNormalCount) || 0));
    }
    if (source.fertilizerBuyNormalThresholdHours !== undefined && source.fertilizerBuyNormalThresholdHours !== null) {
        config.fertilizerBuyNormalThresholdHours = Math.max(0, Math.min(990, Number(source.fertilizerBuyNormalThresholdHours) || 0));
    }
    if (source.fertilizerBuyCheckIntervalMinutes !== undefined && source.fertilizerBuyCheckIntervalMinutes !== null) {
        config.fertilizerBuyCheckIntervalMinutes = Math.max(1, Math.min(1440, Number(source.fertilizerBuyCheckIntervalMinutes) || 30));
    }
    if (source.bagSeedPriority !== undefined && source.bagSeedPriority !== null) {
        config.bagSeedPriority = normalizeBagSeedPriority(source.bagSeedPriority);
    }
    if (source.bagSeedFallbackStrategy !== undefined && source.bagSeedFallbackStrategy !== null) {
        config.bagSeedFallbackStrategy = normalizeBagSeedFallbackStrategy(source.bagSeedFallbackStrategy);
    }
    return config;
}
