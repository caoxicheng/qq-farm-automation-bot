const process = require('node:process');
/**
 * 运行时存储 - 自动化开关、种子偏好、账号管理
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readTextFile, readJsonFile, writeJsonFileAtomic } = require('../services/json-db');

const STORE_FILE = getDataFile('store.json');
const ACCOUNTS_FILE = getDataFile('accounts.json');
const KNOWN_FRIEND_GIDS_DIR = getDataFile('known_friend_gids');

function ensureKnownFriendGidsDir() {
    if (!fs.existsSync(KNOWN_FRIEND_GIDS_DIR)) {
        fs.mkdirSync(KNOWN_FRIEND_GIDS_DIR, { recursive: true });
    }
    return KNOWN_FRIEND_GIDS_DIR;
}

function getKnownFriendGidsCacheFile(accountId) {
    const safeId = String(accountId || '').replace(/[^\w-]/g, '_');
    return path.join(ensureKnownFriendGidsDir(), `${safeId}.json`);
}

function readKnownFriendGidsCache(accountId) {
    try {
        const file = getKnownFriendGidsCacheFile(accountId);
        if (fs.existsSync(file)) {
            const data = readJsonFile(file);
            if (data && Array.isArray(data.gids)) {
                return data.gids;
            }
        }
    } catch {
        // 忽略读取错误
    }
    return null;
}

function writeKnownFriendGidsCache(accountId, gids) {
    try {
        const file = getKnownFriendGidsCacheFile(accountId);
        writeJsonFileAtomic(file, {
            gids: gids || [],
            updatedAt: Date.now(),
        });
    } catch {
        // 忽略写入错误
    }
}
const ALLOWED_PLANTING_STRATEGIES = ['preferred', 'level', 'max_exp', 'max_fert_exp', 'max_profit', 'max_fert_profit', 'bag_priority'];
const ALLOWED_BAG_SEED_FALLBACK_STRATEGIES = ALLOWED_PLANTING_STRATEGIES.filter(s => s !== 'bag_priority');
const PUSHOO_CHANNELS = new Set([
    'webhook', 'qmsg', 'serverchan', 'pushplus', 'pushplushxtrip',
    'dingtalk', 'wecom', 'bark', 'gocqhttp', 'onebot', 'atri',
    'pushdeer', 'igot', 'telegram', 'feishu', 'ifttt', 'wecombot',
    'discord', 'wxpusher',
]);

const DEFAULT_FERTILIZER_LAND_TYPES = ['gold', 'black', 'red', 'normal'];
const FERTILIZER_LAND_TYPE_SET = new Set(DEFAULT_FERTILIZER_LAND_TYPES);
const INTERVAL_MAX_SEC = 86400;
const DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC = 300;
const DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC = 60;

function normalizeKnownFriendGids(input, fallback = []) {
    const source = Array.isArray(input) ? input : fallback;
    const normalized = [];
    for (const item of source) {
        const value = Number.parseInt(item, 10);
        if (!Number.isFinite(value) || value <= 0) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

function normalizeKnownFriendGidSyncCooldownSec(input, fallback = DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC) {
    const value = Number.parseInt(input, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(30, Math.min(INTERVAL_MAX_SEC, base));
}

function normalizeFriendsListCacheTtlSec(input, fallback = DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC) {
    const value = Number.parseInt(input, 10);
    const base = Number.isFinite(value) ? value : fallback;
    return Math.max(10, Math.min(INTERVAL_MAX_SEC, base));
}

function normalizeBagSeedPriority(input) {
    if (!Array.isArray(input)) return [];
    const normalized = [];
    for (const item of input) {
        const value = Number.parseInt(item, 10);
        if (!Number.isFinite(value) || value <= 0) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

function normalizeBagSeedFallbackStrategy(input, fallback = 'level') {
    const strategy = String(input || '').trim();
    if (ALLOWED_BAG_SEED_FALLBACK_STRATEGIES.includes(strategy)) return strategy;
    return fallback;
}

const DEFAULT_OFFLINE_REMINDER = {
    channel: 'webhook',
    reloginUrlMode: 'none',
    endpoint: '',
    token: '',
    title: '账号下线提醒',
    msg: '账号下线',
    offlineDeleteSec: 0,
};
// ============ 全局配置 ============
const DEFAULT_ACCOUNT_CONFIG = {
    automation: {
        farm: true,
        farm_push: true,   // 收到 LandsNotify 推送时是否立即触发巡田
        land_upgrade: false, // 是否自动升级土地
        friend: true,       // 好友互动总开关
        friend_help_exp_limit: true, // 帮忙经验达上限后自动停止帮忙
        friend_steal: true, // 偷菜
        friend_help: true,  // 帮忙
        friend_bad: false,  // 捣乱(放虫草)
        task: true,
        // 以下功能默认启用，不再提供开关
        // email: true,
        // free_gifts: true,
        // share_reward: true,
        // vip_gift: true,
        // month_card: true,
        // open_server_gift: true,
        fertilizer_gift: false,
        fertilizer_buy_organic: false,
        fertilizer_buy_normal: false,
        sell: false,
        fertilizer: 'smart',
        fertilizer_multi_season: true,
        fertilizer_land_types: [...DEFAULT_FERTILIZER_LAND_TYPES],
        fertilizer_smart_seconds: 300,
        skip_own_weed_bug: true,  // 不除自己草虫
    },
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    intervals: {
        farm: 2,
        farmMin: 20,
        farmMax: 25,
        // 好友巡查：帮助和偷菜各自独立的间隔
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
    // 蔬菜黑名单（偷菜时不偷的作物 seedId 列表）
    plantBlacklist: [
        20002,
        20003,
        20059,
        20065,
        20064,
        20060,
        20061,
    ],
    // 好友作物成熟后延迟多少秒再偷取（0=不延迟）
    stealDelaySeconds: 1,
    // 自己农田种植时是否随机地块顺序
    plantOrderRandom: true,
    // 自己农田种植时每块地间隔秒数（0=使用默认50ms）
    plantDelaySeconds: 2,
    // 有机化肥购买数量
    fertilizerBuyOrganicCount: 1,
    // 有机化肥自动购买触发阈值（小时）
    fertilizerBuyOrganicThresholdHours: 10,
    // 无机化肥购买数量
    fertilizerBuyNormalCount: 1,
    // 无机化肥自动购买触发阈值（小时）
    fertilizerBuyNormalThresholdHours: 10,
    // 化肥自动购买检测间隔（分钟）
    fertilizerBuyCheckIntervalMinutes: 60,
    // 背包种子优先顺序（seedId 数组）
    bagSeedPriority: [],
    // 背包种子用完后的回退策略
    bagSeedFallbackStrategy: 'level',
    // 自动重登配置（默认关闭，需在 Web 面板手动开启）
    autoRelogin: {
        enabled: false,
        delayMinutes: 15,
        maxPerDay: 3,
        kickWindowMinutes: 10,
        loginFailWindowSec: 60,
    },
};
const ALLOWED_AUTOMATION_KEYS = new Set(Object.keys(DEFAULT_ACCOUNT_CONFIG.automation));

let accountFallbackConfig = {
    ...DEFAULT_ACCOUNT_CONFIG,
    // automation: { ...DEFAULT_ACCOUNT_CONFIG.automation },
    automation: { ...DEFAULT_ACCOUNT_CONFIG.automation, fertilizer_land_types: [...DEFAULT_FERTILIZER_LAND_TYPES] },
    intervals: { ...DEFAULT_ACCOUNT_CONFIG.intervals },
    friendQuietHours: { ...DEFAULT_ACCOUNT_CONFIG.friendQuietHours },
    knownFriendGids: [],
    knownFriendGidSyncCooldownSec: DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    friendsListCacheTtlSec: DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
};

const globalConfig = {
    accountConfigs: {},
    defaultAccountConfig: cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG),
    ui: {
        theme: 'light',
    },
    offlineReminder: { ...DEFAULT_OFFLINE_REMINDER },
    // 用户隔离的下线提醒配置: { [username]: config }
    userOfflineReminders: {},
    adminPasswordHash: '',
    // 公告配置
    announcement: {
        content: '',
        showOnce: true,
        updatedAt: 0,
    },
    // 用户已读公告记录: { [username]: updatedAt }
    announcementReadRecords: {},
    // 系统运行配置
    systemConfig: null,
    // 全局微信配置
    globalWxConfig: null,
};

function normalizeOfflineReminder(input) {
    const src = (input && typeof input === 'object') ? input : {};
    let offlineDeleteSec = Number.parseInt(src.offlineDeleteSec, 10);
    if (!Number.isFinite(offlineDeleteSec) || offlineDeleteSec < 0) {
        offlineDeleteSec = DEFAULT_OFFLINE_REMINDER.offlineDeleteSec;
    }
    const rawChannel = (src.channel !== undefined && src.channel !== null)
        ? String(src.channel).trim().toLowerCase()
        : '';
    const endpoint = (src.endpoint !== undefined && src.endpoint !== null)
        ? String(src.endpoint).trim()
        : DEFAULT_OFFLINE_REMINDER.endpoint;
    const migratedChannel = rawChannel
        || (PUSHOO_CHANNELS.has(String(endpoint || '').trim().toLowerCase())
            ? String(endpoint || '').trim().toLowerCase()
            : DEFAULT_OFFLINE_REMINDER.channel);
    const channel = PUSHOO_CHANNELS.has(migratedChannel)
        ? migratedChannel
        : DEFAULT_OFFLINE_REMINDER.channel;
    const rawReloginUrlMode = (src.reloginUrlMode !== undefined && src.reloginUrlMode !== null)
        ? String(src.reloginUrlMode).trim().toLowerCase()
        : DEFAULT_OFFLINE_REMINDER.reloginUrlMode;
    const reloginUrlMode = new Set(['none', 'qq_link', 'qr_link']).has(rawReloginUrlMode)
        ? rawReloginUrlMode
        : DEFAULT_OFFLINE_REMINDER.reloginUrlMode;
    const token = (src.token !== undefined && src.token !== null)
        ? String(src.token).trim()
        : DEFAULT_OFFLINE_REMINDER.token;
    const title = (src.title !== undefined && src.title !== null)
        ? String(src.title).trim()
        : DEFAULT_OFFLINE_REMINDER.title;
    const msg = (src.msg !== undefined && src.msg !== null)
        ? String(src.msg).trim()
        : DEFAULT_OFFLINE_REMINDER.msg;
    return {
        channel,
        reloginUrlMode,
        endpoint,
        token,
        title,
        msg,
        offlineDeleteSec,
    };
}
function normalizeFertilizerLandTypes(input, fallback = DEFAULT_FERTILIZER_LAND_TYPES) {
    const source = Array.isArray(input) ? input : fallback;
    const normalized = [];
    for (const item of source) {
        const value = String(item || '').trim().toLowerCase();
        if (!FERTILIZER_LAND_TYPE_SET.has(value)) continue;
        if (normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

function cloneAccountConfig(base = DEFAULT_ACCOUNT_CONFIG) {
    const srcAutomation = (base && base.automation && typeof base.automation === 'object')
        ? base.automation
        : {};
    const automation = { ...DEFAULT_ACCOUNT_CONFIG.automation };
    for (const key of Object.keys(automation)) {
        if (key === 'fertilizer_land_types') {
            automation[key] = normalizeFertilizerLandTypes(srcAutomation[key], DEFAULT_FERTILIZER_LAND_TYPES);
            continue;
        }
        if (srcAutomation[key] !== undefined) automation[key] = srcAutomation[key];
    }

    const rawBlacklist = Array.isArray(base.friendBlacklist) ? base.friendBlacklist : [];

    const knownFriendGids = normalizeKnownFriendGids(base.knownFriendGids);
    const knownFriendGidSyncCooldownSec = normalizeKnownFriendGidSyncCooldownSec(base.knownFriendGidSyncCooldownSec);
    const friendsListCacheTtlSec = normalizeFriendsListCacheTtlSec(base.friendsListCacheTtlSec);

    // 蔬菜黑名单
    const rawPlantBlacklist = Array.isArray(base.plantBlacklist) ? base.plantBlacklist : [];

    const autoRelogin = normalizeAutoRelogin(base.autoRelogin, DEFAULT_ACCOUNT_CONFIG.autoRelogin);

    return {
        ...base,
        automation,
        intervals: { ...(base.intervals || DEFAULT_ACCOUNT_CONFIG.intervals) },
        friendQuietHours: { ...(base.friendQuietHours || DEFAULT_ACCOUNT_CONFIG.friendQuietHours) },
        autoRelogin,
        knownFriendGids,
        knownFriendGidSyncCooldownSec,
        friendsListCacheTtlSec,
        friendBlacklist: rawBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        plantingStrategy: ALLOWED_PLANTING_STRATEGIES.includes(String(base.plantingStrategy || ''))
            ? String(base.plantingStrategy)
            : DEFAULT_ACCOUNT_CONFIG.plantingStrategy,
        preferredSeedId: Math.max(0, Number.parseInt(base.preferredSeedId, 10) || 0),
        plantBlacklist: rawPlantBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        stealDelaySeconds: Math.max(0, Math.min(300, Number(base.stealDelaySeconds) || 0)),
        plantOrderRandom: !!(base.plantOrderRandom),
        plantDelaySeconds: Math.max(0, Math.min(60, Number(base.plantDelaySeconds) || 0)),
        fertilizerBuyOrganicCount: Math.max(0, Math.min(10000, Number(base.fertilizerBuyOrganicCount) || 0)),
        fertilizerBuyOrganicThresholdHours: Math.max(0, Math.min(990, Number(base.fertilizerBuyOrganicThresholdHours) || 0)),
        fertilizerBuyNormalCount: Math.max(0, Math.min(10000, Number(base.fertilizerBuyNormalCount) || 0)),
        fertilizerBuyNormalThresholdHours: Math.max(0, Math.min(990, Number(base.fertilizerBuyNormalThresholdHours) || 0)),
        fertilizerBuyCheckIntervalMinutes: Math.max(1, Math.min(1440, Number(base.fertilizerBuyCheckIntervalMinutes) || 30)),
        bagSeedPriority: normalizeBagSeedPriority(base.bagSeedPriority),
        bagSeedFallbackStrategy: normalizeBagSeedFallbackStrategy(base.bagSeedFallbackStrategy),
    };
}

function resolveAccountId(accountId) {
    const direct = (accountId !== undefined && accountId !== null) ? String(accountId).trim() : '';
    if (direct) return direct;
    const envId = String(process.env.FARM_ACCOUNT_ID || '').trim();
    return envId;
}

function normalizeAccountConfig(input, fallback = accountFallbackConfig) {
    const src = (input && typeof input === 'object') ? input : {};
    const cfg = cloneAccountConfig(fallback || DEFAULT_ACCOUNT_CONFIG);

    if (src.automation && typeof src.automation === 'object') {
        for (const [k, v] of Object.entries(src.automation)) {
            if (!ALLOWED_AUTOMATION_KEYS.has(k)) continue;
            if (k === 'fertilizer') {
                const allowed = ['both', 'normal', 'organic', 'smart', 'none'];
                cfg.automation[k] = allowed.includes(v) ? v : cfg.automation[k];
            } else if (k === 'fertilizer_land_types') {
                cfg.automation[k] = normalizeFertilizerLandTypes(v, cfg.automation[k]);
            } else if (k === 'fertilizer_smart_seconds') {
                cfg.automation[k] = Math.max(30, Math.min(3600, Number(v) || 300));
            } else {
                cfg.automation[k] = !!v;
            }
        }
    }

    if (src.plantingStrategy && ALLOWED_PLANTING_STRATEGIES.includes(src.plantingStrategy)) {
        cfg.plantingStrategy = src.plantingStrategy;
    }

    if (src.preferredSeedId !== undefined && src.preferredSeedId !== null) {
        cfg.preferredSeedId = Math.max(0, Number.parseInt(src.preferredSeedId, 10) || 0);
    }

    if (src.intervals && typeof src.intervals === 'object') {
        for (const [type, sec] of Object.entries(src.intervals)) {
            if (cfg.intervals[type] === undefined) continue;
            cfg.intervals[type] = Math.max(1, Number.parseInt(sec, 10) || cfg.intervals[type] || 1);
        }
        cfg.intervals = normalizeIntervals(cfg.intervals);
    } else {
        cfg.intervals = normalizeIntervals(cfg.intervals);
    }

    if (src.friendQuietHours && typeof src.friendQuietHours === 'object') {
        const old = cfg.friendQuietHours || {};
        cfg.friendQuietHours = {
            enabled: src.friendQuietHours.enabled !== undefined ? !!src.friendQuietHours.enabled : !!old.enabled,
            start: normalizeTimeString(src.friendQuietHours.start, old.start || '23:00'),
            end: normalizeTimeString(src.friendQuietHours.end, old.end || '07:00'),
        };
    }

    if (src.autoRelogin && typeof src.autoRelogin === 'object') {
        const old = cfg.autoRelogin || DEFAULT_ACCOUNT_CONFIG.autoRelogin;
        cfg.autoRelogin = normalizeAutoRelogin({
            enabled: src.autoRelogin.enabled !== undefined ? !!src.autoRelogin.enabled : !!old.enabled,
            delayMinutes: src.autoRelogin.delayMinutes !== undefined ? src.autoRelogin.delayMinutes : old.delayMinutes,
            maxPerDay: src.autoRelogin.maxPerDay !== undefined ? src.autoRelogin.maxPerDay : old.maxPerDay,
            kickWindowMinutes: src.autoRelogin.kickWindowMinutes !== undefined ? src.autoRelogin.kickWindowMinutes : old.kickWindowMinutes,
            loginFailWindowSec: src.autoRelogin.loginFailWindowSec !== undefined ? src.autoRelogin.loginFailWindowSec : old.loginFailWindowSec,
        }, old);
    }

    if (Array.isArray(src.friendBlacklist)) {
        cfg.friendBlacklist = src.friendBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    if (src.knownFriendGids !== undefined) {
        cfg.knownFriendGids = normalizeKnownFriendGids(src.knownFriendGids, cfg.knownFriendGids);
    }

    if (src.knownFriendGidSyncCooldownSec !== undefined) {
        cfg.knownFriendGidSyncCooldownSec = normalizeKnownFriendGidSyncCooldownSec(
            src.knownFriendGidSyncCooldownSec,
            cfg.knownFriendGidSyncCooldownSec,
        );
    }

    if (src.friendsListCacheTtlSec !== undefined) {
        cfg.friendsListCacheTtlSec = normalizeFriendsListCacheTtlSec(
            src.friendsListCacheTtlSec,
            cfg.friendsListCacheTtlSec,
        );
    }

    // 蔬菜黑名单
    if (Array.isArray(src.plantBlacklist)) {
        cfg.plantBlacklist = src.plantBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 偷取延迟
    if (src.stealDelaySeconds !== undefined && src.stealDelaySeconds !== null) {
        cfg.stealDelaySeconds = Math.max(0, Math.min(300, Number.parseInt(src.stealDelaySeconds, 10) || 0));
    }

    // 种植顺序随机
    if (src.plantOrderRandom !== undefined && src.plantOrderRandom !== null) {
        cfg.plantOrderRandom = !!src.plantOrderRandom;
    }

    // 种植延迟
    if (src.plantDelaySeconds !== undefined && src.plantDelaySeconds !== null) {
        cfg.plantDelaySeconds = Math.max(0, Math.min(60, Number(src.plantDelaySeconds) || 0));
    }

    // 有机化肥购买数量
    if (src.fertilizerBuyOrganicCount !== undefined && src.fertilizerBuyOrganicCount !== null) {
        cfg.fertilizerBuyOrganicCount = Math.max(0, Math.min(10000, Number(src.fertilizerBuyOrganicCount) || 0));
    }

    // 有机化肥自动购买触发阈值
    if (src.fertilizerBuyOrganicThresholdHours !== undefined && src.fertilizerBuyOrganicThresholdHours !== null) {
        cfg.fertilizerBuyOrganicThresholdHours = Math.max(0, Math.min(990, Number(src.fertilizerBuyOrganicThresholdHours) || 0));
    }

    // 无机化肥购买数量
    if (src.fertilizerBuyNormalCount !== undefined && src.fertilizerBuyNormalCount !== null) {
        cfg.fertilizerBuyNormalCount = Math.max(0, Math.min(10000, Number(src.fertilizerBuyNormalCount) || 0));
    }

    // 无机化肥自动购买触发阈值
    if (src.fertilizerBuyNormalThresholdHours !== undefined && src.fertilizerBuyNormalThresholdHours !== null) {
        cfg.fertilizerBuyNormalThresholdHours = Math.max(0, Math.min(990, Number(src.fertilizerBuyNormalThresholdHours) || 0));
    }

    // 化肥自动购买检测间隔
    if (src.fertilizerBuyCheckIntervalMinutes !== undefined && src.fertilizerBuyCheckIntervalMinutes !== null) {
        cfg.fertilizerBuyCheckIntervalMinutes = Math.max(1, Math.min(1440, Number(src.fertilizerBuyCheckIntervalMinutes) || 30));
    }

    // 背包种子优先顺序
    if (src.bagSeedPriority !== undefined && src.bagSeedPriority !== null) {
        cfg.bagSeedPriority = normalizeBagSeedPriority(src.bagSeedPriority);
    }

    // 背包种子回退策略
    if (src.bagSeedFallbackStrategy !== undefined && src.bagSeedFallbackStrategy !== null) {
        cfg.bagSeedFallbackStrategy = normalizeBagSeedFallbackStrategy(src.bagSeedFallbackStrategy);
    }

    return cfg;
}

function getAccountConfigSnapshot(accountId) {
    const id = resolveAccountId(accountId);
    if (!id) return cloneAccountConfig(accountFallbackConfig);
    return normalizeAccountConfig(globalConfig.accountConfigs[id], accountFallbackConfig);
}

function setAccountConfigSnapshot(accountId, nextConfig, persist = true) {
    const id = resolveAccountId(accountId);
    if (!id) {
        accountFallbackConfig = normalizeAccountConfig(nextConfig, accountFallbackConfig);
        globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);
        if (persist) saveGlobalConfig();
        return cloneAccountConfig(accountFallbackConfig);
    }
    globalConfig.accountConfigs[id] = normalizeAccountConfig(nextConfig, accountFallbackConfig);
    if (persist) saveGlobalConfig();
    return cloneAccountConfig(globalConfig.accountConfigs[id]);
}

function removeAccountConfig(accountId) {
    const id = resolveAccountId(accountId);
    if (!id) return;
    if (globalConfig.accountConfigs[id]) {
        delete globalConfig.accountConfigs[id];
        saveGlobalConfig();
    }
}

function ensureAccountConfig(accountId, options = {}) {
    const id = resolveAccountId(accountId);
    if (!id) return null;
    if (globalConfig.accountConfigs[id]) {
        return cloneAccountConfig(globalConfig.accountConfigs[id]);
    }
    globalConfig.accountConfigs[id] = cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG);
    if (options.persist !== false) saveGlobalConfig();
    return cloneAccountConfig(globalConfig.accountConfigs[id]);
}

// 加载全局配置
function loadGlobalConfig() {
    ensureDataDir();
    try {
        const data = readJsonFile(STORE_FILE, () => ({}));
        if (data && typeof data === 'object') {
            // 先设置 accountFallbackConfig 为默认值，确保后续规范化使用正确的 fallback
            accountFallbackConfig = cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG);
            globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);

            // 加载账号配置，使用 DEFAULT_ACCOUNT_CONFIG 作为 fallback
            const cfgMap = (data.accountConfigs && typeof data.accountConfigs === 'object')
                ? data.accountConfigs
                : {};
            globalConfig.accountConfigs = {};
            for (const [id, cfg] of Object.entries(cfgMap)) {
                const sid = String(id || '').trim();
                if (!sid) continue;
                globalConfig.accountConfigs[sid] = normalizeAccountConfig(cfg, DEFAULT_ACCOUNT_CONFIG);
            }
            // 统一规范化，确保内存中不残留旧字段（如 automation.friend）
            for (const [id, cfg] of Object.entries(globalConfig.accountConfigs)) {
                globalConfig.accountConfigs[id] = normalizeAccountConfig(cfg, DEFAULT_ACCOUNT_CONFIG);
            }
            globalConfig.ui = { ...globalConfig.ui, ...(data.ui || {}) };
            const theme = String(globalConfig.ui.theme || '').toLowerCase();
            globalConfig.ui.theme = theme === 'light' ? 'light' : 'dark';
            globalConfig.offlineReminder = normalizeOfflineReminder(data.offlineReminder);

            // 加载用户隔离的下线提醒配置
            if (data.userOfflineReminders && typeof data.userOfflineReminders === 'object') {
                globalConfig.userOfflineReminders = {};
                for (const [username, cfg] of Object.entries(data.userOfflineReminders)) {
                    if (username && cfg) {
                        globalConfig.userOfflineReminders[username] = normalizeOfflineReminder(cfg);
                    }
                }
            }
            // 兼容旧版本：将全局 offlineReminder 迁移到 admin 用户（如果存在）
            if (data.offlineReminder && typeof data.offlineReminder === 'object') {
                const legacyCfg = normalizeOfflineReminder(data.offlineReminder);
                // 只有当 admin 用户没有配置时才迁移
                if (!globalConfig.userOfflineReminders.admin) {
                    globalConfig.userOfflineReminders.admin = legacyCfg;
                }
            }

            if (typeof data.adminPasswordHash === 'string') {
                globalConfig.adminPasswordHash = data.adminPasswordHash;
            }

            // 加载公告配置
            if (data.announcement && typeof data.announcement === 'object') {
                globalConfig.announcement = {
                    content: String(data.announcement.content || '').trim(),
                    showOnce: data.announcement.showOnce !== false,
                    updatedAt: Number(data.announcement.updatedAt) || 0,
                };
            }
            // 加载公告已读记录
            if (data.announcementReadRecords && typeof data.announcementReadRecords === 'object') {
                globalConfig.announcementReadRecords = { ...data.announcementReadRecords };
            }

            // 加载系统运行配置
            if (data.systemConfig && typeof data.systemConfig === 'object') {
                globalConfig.systemConfig = {
                    serverUrl: String(data.systemConfig.serverUrl || '').trim(),
                    clientVersion: String(data.systemConfig.clientVersion || '').trim(),
                    platform: String(data.systemConfig.platform || 'qq').trim(),
                    os: String(data.systemConfig.os || 'iOS').trim(),
                    versionPrefix: String(data.systemConfig.versionPrefix || '').trim(),
                };
            }

            // 加载全局微信配置
            if (data.globalWxConfig && typeof data.globalWxConfig === 'object') {
                globalConfig.globalWxConfig = {
                    enabled: data.globalWxConfig.enabled !== false,
                    apiBase: String(data.globalWxConfig.apiBase || '/api').trim(),
                    apiKey: String(data.globalWxConfig.apiKey || '').trim(),
                    proxyApiUrl: String(data.globalWxConfig.proxyApiUrl || 'http://127.0.0.1:8059/api').trim(),
                    appId: String(data.globalWxConfig.appId || 'wx5306c5978fdb76e4').trim(),
                    autoAddAccount: data.globalWxConfig.autoAddAccount !== false,
                    userIsolation: data.globalWxConfig.userIsolation !== false,
                };
            }
        }
    } catch (e) {
        console.error('加载配置失败:', e.message);
    }
}

function sanitizeGlobalConfigBeforeSave() {
    // default 配置统一白名单净化
    accountFallbackConfig = normalizeAccountConfig(globalConfig.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG);
    globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);

    // 每个账号配置也统一净化（使用 DEFAULT_ACCOUNT_CONFIG 作为 fallback，确保新账号使用正确的默认值）
    const map = (globalConfig.accountConfigs && typeof globalConfig.accountConfigs === 'object')
        ? globalConfig.accountConfigs
        : {};
    const nextMap = {};
    for (const [id, cfg] of Object.entries(map)) {
        const sid = String(id || '').trim();
        if (!sid) continue;
        nextMap[sid] = normalizeAccountConfig(cfg, DEFAULT_ACCOUNT_CONFIG);
    }
    globalConfig.accountConfigs = nextMap;

    // 净化用户隔离的下线提醒配置
    const userReminders = (globalConfig.userOfflineReminders && typeof globalConfig.userOfflineReminders === 'object')
        ? globalConfig.userOfflineReminders
        : {};
    const nextReminders = {};
    for (const [username, cfg] of Object.entries(userReminders)) {
        const u = String(username || '').trim();
        if (!u) continue;
        nextReminders[u] = normalizeOfflineReminder(cfg);
    }
    globalConfig.userOfflineReminders = nextReminders;
}

// 保存全局配置
function saveGlobalConfig() {
    ensureDataDir();
    try {
        const oldJson = readTextFile(STORE_FILE, '');

        sanitizeGlobalConfigBeforeSave();
        const newJson = JSON.stringify(globalConfig, null, 2);

        if (oldJson !== newJson) {
            console.warn('[系统] 正在保存配置到:', STORE_FILE);
            writeJsonFileAtomic(STORE_FILE, globalConfig);
        }
    } catch (e) {
        console.error('保存配置失败:', e.message);
    }
}

function getAdminPasswordHash() {
    return String(globalConfig.adminPasswordHash || '');
}

function setAdminPasswordHash(hash) {
    globalConfig.adminPasswordHash = String(hash || '');
    saveGlobalConfig();
    return globalConfig.adminPasswordHash;
}

// 初始化加载
loadGlobalConfig();

function getAutomation(accountId) {
    // return { ...getAccountConfigSnapshot(accountId).automation };
    const automation = { ...getAccountConfigSnapshot(accountId).automation };
    automation.fertilizer_land_types = normalizeFertilizerLandTypes(automation.fertilizer_land_types);
    return automation;
}

function getConfigSnapshot(accountId) {
    const cfg = getAccountConfigSnapshot(accountId);
    return {
        automation: { ...cfg.automation },
        plantingStrategy: cfg.plantingStrategy,
        preferredSeedId: cfg.preferredSeedId,
        intervals: { ...cfg.intervals },
        friendQuietHours: { ...cfg.friendQuietHours },
        autoRelogin: { ...cfg.autoRelogin },
        knownFriendGids: [...(cfg.knownFriendGids || [])],
        knownFriendGidSyncCooldownSec: cfg.knownFriendGidSyncCooldownSec,
        friendsListCacheTtlSec: cfg.friendsListCacheTtlSec,
        friendBlacklist: [...(cfg.friendBlacklist || [])],
        plantBlacklist: [...(cfg.plantBlacklist || [])],
        stealDelaySeconds: Math.max(0, Math.min(300, Number(cfg.stealDelaySeconds) || 0)),
        plantOrderRandom: !!cfg.plantOrderRandom,
        plantDelaySeconds: Math.max(0, Math.min(60, Number(cfg.plantDelaySeconds) || 0)),
        fertilizerBuyOrganicCount: Math.max(0, Math.min(10000, Number(cfg.fertilizerBuyOrganicCount) || 0)),
        fertilizerBuyOrganicThresholdHours: Math.max(0, Math.min(990, Number(cfg.fertilizerBuyOrganicThresholdHours) || 0)),
        fertilizerBuyNormalCount: Math.max(0, Math.min(10000, Number(cfg.fertilizerBuyNormalCount) || 0)),
        fertilizerBuyNormalThresholdHours: Math.max(0, Math.min(990, Number(cfg.fertilizerBuyNormalThresholdHours) || 0)),
        fertilizerBuyCheckIntervalMinutes: Math.max(1, Math.min(1440, Number(cfg.fertilizerBuyCheckIntervalMinutes) || 30)),
        ui: { ...globalConfig.ui },
    };
}

function applyConfigSnapshot(snapshot, options = {}) {
    const cfg = snapshot || {};
    const persist = options.persist !== false;
    const accountId = options.accountId;

    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);

    if (cfg.automation && typeof cfg.automation === 'object') {
        for (const [k, v] of Object.entries(cfg.automation)) {
            if (next.automation[k] === undefined) continue;
            if (k === 'fertilizer') {
                const allowed = ['both', 'normal', 'organic', 'smart', 'none'];
                next.automation[k] = allowed.includes(v) ? v : next.automation[k];
            } else if (k === 'fertilizer_land_types') {
                next.automation[k] = normalizeFertilizerLandTypes(v, next.automation[k]);
            } else if (k === 'fertilizer_smart_seconds') {
                next.automation[k] = Math.max(30, Math.min(3600, Number(v) || 300));
            } else {
                next.automation[k] = !!v;
            }
        }
    }

    if (cfg.plantingStrategy && ALLOWED_PLANTING_STRATEGIES.includes(cfg.plantingStrategy)) {
        next.plantingStrategy = cfg.plantingStrategy;
    }

    if (cfg.preferredSeedId !== undefined && cfg.preferredSeedId !== null) {
        next.preferredSeedId = Math.max(0, Number.parseInt(cfg.preferredSeedId, 10) || 0);
    }

    if (cfg.intervals && typeof cfg.intervals === 'object') {
        for (const [type, sec] of Object.entries(cfg.intervals)) {
            if (next.intervals[type] === undefined) continue;
            next.intervals[type] = Math.max(1, Number.parseInt(sec, 10) || next.intervals[type] || 1);
        }
        next.intervals = normalizeIntervals(next.intervals);
    }

    if (cfg.friendQuietHours && typeof cfg.friendQuietHours === 'object') {
        const old = next.friendQuietHours || {};
        next.friendQuietHours = {
            enabled: cfg.friendQuietHours.enabled !== undefined ? !!cfg.friendQuietHours.enabled : !!old.enabled,
            start: normalizeTimeString(cfg.friendQuietHours.start, old.start || '23:00'),
            end: normalizeTimeString(cfg.friendQuietHours.end, old.end || '07:00'),
        };
    }

    if (cfg.autoRelogin && typeof cfg.autoRelogin === 'object') {
        const old = next.autoRelogin || DEFAULT_ACCOUNT_CONFIG.autoRelogin;
        next.autoRelogin = normalizeAutoRelogin({
            enabled: cfg.autoRelogin.enabled !== undefined ? !!cfg.autoRelogin.enabled : !!old.enabled,
            delayMinutes: cfg.autoRelogin.delayMinutes !== undefined ? cfg.autoRelogin.delayMinutes : old.delayMinutes,
            maxPerDay: cfg.autoRelogin.maxPerDay !== undefined ? cfg.autoRelogin.maxPerDay : old.maxPerDay,
            kickWindowMinutes: cfg.autoRelogin.kickWindowMinutes !== undefined ? cfg.autoRelogin.kickWindowMinutes : old.kickWindowMinutes,
            loginFailWindowSec: cfg.autoRelogin.loginFailWindowSec !== undefined ? cfg.autoRelogin.loginFailWindowSec : old.loginFailWindowSec,
        }, old);
    }

    if (Array.isArray(cfg.friendBlacklist)) {
        next.friendBlacklist = cfg.friendBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    if (cfg.knownFriendGids !== undefined) {
        next.knownFriendGids = normalizeKnownFriendGids(cfg.knownFriendGids, next.knownFriendGids);
        // 同时写入缓存文件
        if (accountId) {
            writeKnownFriendGidsCache(accountId, next.knownFriendGids);
        }
    }

    if (cfg.knownFriendGidSyncCooldownSec !== undefined) {
        next.knownFriendGidSyncCooldownSec = normalizeKnownFriendGidSyncCooldownSec(
            cfg.knownFriendGidSyncCooldownSec,
            next.knownFriendGidSyncCooldownSec,
        );
    }

    if (cfg.friendsListCacheTtlSec !== undefined) {
        next.friendsListCacheTtlSec = normalizeFriendsListCacheTtlSec(
            cfg.friendsListCacheTtlSec,
            next.friendsListCacheTtlSec,
        );
    }

    // 蔬菜黑名单
    if (Array.isArray(cfg.plantBlacklist)) {
        next.plantBlacklist = cfg.plantBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 偷取延迟
    if (cfg.stealDelaySeconds !== undefined && cfg.stealDelaySeconds !== null) {
        next.stealDelaySeconds = Math.max(0, Math.min(300, Number(cfg.stealDelaySeconds) || 0));
    }

    // 种植顺序随机
    if (cfg.plantOrderRandom !== undefined && cfg.plantOrderRandom !== null) {
        next.plantOrderRandom = !!cfg.plantOrderRandom;
    }

    // 种植延迟
    if (cfg.plantDelaySeconds !== undefined && cfg.plantDelaySeconds !== null) {
        next.plantDelaySeconds = Math.max(0, Math.min(60, Number(cfg.plantDelaySeconds) || 0));
    }

    // 有机化肥购买数量
    if (cfg.fertilizerBuyOrganicCount !== undefined && cfg.fertilizerBuyOrganicCount !== null) {
        next.fertilizerBuyOrganicCount = Math.max(0, Math.min(10000, Number(cfg.fertilizerBuyOrganicCount) || 0));
    }

    // 有机化肥自动购买触发阈值
    if (cfg.fertilizerBuyOrganicThresholdHours !== undefined && cfg.fertilizerBuyOrganicThresholdHours !== null) {
        next.fertilizerBuyOrganicThresholdHours = Math.max(0, Math.min(990, Number(cfg.fertilizerBuyOrganicThresholdHours) || 0));
    }

    // 无机化肥购买数量
    if (cfg.fertilizerBuyNormalCount !== undefined && cfg.fertilizerBuyNormalCount !== null) {
        next.fertilizerBuyNormalCount = Math.max(0, Math.min(10000, Number(cfg.fertilizerBuyNormalCount) || 0));
    }

    // 无机化肥自动购买触发阈值
    if (cfg.fertilizerBuyNormalThresholdHours !== undefined && cfg.fertilizerBuyNormalThresholdHours !== null) {
        next.fertilizerBuyNormalThresholdHours = Math.max(0, Math.min(990, Number(cfg.fertilizerBuyNormalThresholdHours) || 0));
    }

    // 化肥自动购买检测间隔
    if (cfg.fertilizerBuyCheckIntervalMinutes !== undefined && cfg.fertilizerBuyCheckIntervalMinutes !== null) {
        next.fertilizerBuyCheckIntervalMinutes = Math.max(1, Math.min(1440, Number(cfg.fertilizerBuyCheckIntervalMinutes) || 30));
    }

    // 背包种子优先顺序
    if (cfg.bagSeedPriority !== undefined && cfg.bagSeedPriority !== null) {
        next.bagSeedPriority = normalizeBagSeedPriority(cfg.bagSeedPriority);
    }

    // 背包种子回退策略
    if (cfg.bagSeedFallbackStrategy !== undefined && cfg.bagSeedFallbackStrategy !== null) {
        next.bagSeedFallbackStrategy = normalizeBagSeedFallbackStrategy(cfg.bagSeedFallbackStrategy);
    }

    if (cfg.ui && typeof cfg.ui === 'object') {
        const theme = String(cfg.ui.theme || '').toLowerCase();
        if (theme === 'dark' || theme === 'light') {
            globalConfig.ui.theme = theme;
        }
    }

    setAccountConfigSnapshot(accountId, next, false);
    if (persist) saveGlobalConfig();
    return getConfigSnapshot(accountId);
}

function setAutomation(key, value, accountId) {
    return applyConfigSnapshot({ automation: { [key]: value } }, { accountId });
}

function isAutomationOn(key, accountId) {
    return !!getAccountConfigSnapshot(accountId).automation[key];
}

function getPreferredSeed(accountId) {
    return getAccountConfigSnapshot(accountId).preferredSeedId;
}

function getPlantingStrategy(accountId) {
    return getAccountConfigSnapshot(accountId).plantingStrategy;
}

function getBagSeedPriority(accountId) {
    return [...(getAccountConfigSnapshot(accountId).bagSeedPriority || [])];
}

function getBagSeedFallbackStrategy(accountId) {
    return normalizeBagSeedFallbackStrategy(getAccountConfigSnapshot(accountId).bagSeedFallbackStrategy);
}

function getIntervals(accountId) {
    return { ...getAccountConfigSnapshot(accountId).intervals };
}

function normalizeIntervals(intervals) {
    const src = (intervals && typeof intervals === 'object') ? intervals : {};
    const toSec = (v, d) => Math.max(1, Number.parseInt(v, 10) || d);
    const farm = toSec(src.farm, 2);

    let farmMin = toSec(src.farmMin, farm);
    let farmMax = toSec(src.farmMax, farm);
    if (farmMin > farmMax) [farmMin, farmMax] = [farmMax, farmMin];

    // 帮助和偷菜的独立间隔，默认使用 10 秒
    let helpMin = toSec(src.helpMin, 10);
    let helpMax = toSec(src.helpMax, 10);
    if (helpMin > helpMax) [helpMin, helpMax] = [helpMax, helpMin];

    let stealMin = toSec(src.stealMin, 10);
    let stealMax = toSec(src.stealMax, 10);
    if (stealMin > stealMax) [stealMin, stealMax] = [stealMax, stealMin];

    return {
        ...src,
        farm,
        farmMin,
        farmMax,
        helpMin,
        helpMax,
        stealMin,
        stealMax,
    };
}

function normalizeTimeString(v, fallback) {
    const s = String(v || '').trim();
    const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return fallback;
    const hh = Math.max(0, Math.min(23, Number.parseInt(m[1], 10)));
    const mm = Math.max(0, Math.min(59, Number.parseInt(m[2], 10)));
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function getFriendQuietHours(accountId) {
    return { ...getAccountConfigSnapshot(accountId).friendQuietHours };
}

// ============ 自动重登 ============
function normalizeAutoRelogin(input, fallback = DEFAULT_ACCOUNT_CONFIG.autoRelogin) {
    const src = (input && typeof input === 'object') ? input : {};
    const def = (fallback && typeof fallback === 'object') ? fallback : DEFAULT_ACCOUNT_CONFIG.autoRelogin;
    const num = (v, d, min, max) => {
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n)) return d;
        return Math.max(min, Math.min(max, n));
    };
    return {
        enabled: src.enabled !== undefined ? !!src.enabled : !!def.enabled,
        delayMinutes: num(src.delayMinutes, def.delayMinutes || 15, 1, 1440),
        maxPerDay: num(src.maxPerDay, def.maxPerDay || 3, 1, 100),
        kickWindowMinutes: num(src.kickWindowMinutes, def.kickWindowMinutes || 10, 1, 1440),
        loginFailWindowSec: num(src.loginFailWindowSec, def.loginFailWindowSec || 60, 5, 3600),
    };
}

function getAutoRelogin(accountId) {
    return { ...getAccountConfigSnapshot(accountId).autoRelogin };
}

function getKnownFriendGids(accountId) {
    const config = getAccountConfigSnapshot(accountId);
    const configGids = config.knownFriendGids || [];
    
    // 如果配置中有 GID，直接返回
    if (configGids.length > 0) {
        return [...configGids];
    }
    
    // 否则尝试从缓存文件读取
    const cachedGids = readKnownFriendGidsCache(accountId);
    if (cachedGids && cachedGids.length > 0) {
        return [...cachedGids];
    }
    
    return [];
}

function setKnownFriendGids(accountId, list) {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);
    const normalizedGids = normalizeKnownFriendGids(list, next.knownFriendGids);
    next.knownFriendGids = normalizedGids;
    setAccountConfigSnapshot(accountId, next);
    
    // 同时写入缓存文件
    writeKnownFriendGidsCache(accountId, normalizedGids);
    
    return [...normalizedGids];
}

function getKnownFriendGidSyncCooldownSec(accountId) {
    return normalizeKnownFriendGidSyncCooldownSec(getAccountConfigSnapshot(accountId).knownFriendGidSyncCooldownSec);
}

function setKnownFriendGidSyncCooldownSec(accountId, sec) {
    const current = getAccountConfigSnapshot(accountId);
    const normalized = normalizeKnownFriendGidSyncCooldownSec(sec, current.knownFriendGidSyncCooldownSec);
    const next = normalizeAccountConfig({
        ...current,
        knownFriendGidSyncCooldownSec: normalized,
    }, accountFallbackConfig);
    setAccountConfigSnapshot(accountId, next, true);
    return next.knownFriendGidSyncCooldownSec;
}

function getFriendsListCacheTtlSec(accountId) {
    return normalizeFriendsListCacheTtlSec(getAccountConfigSnapshot(accountId).friendsListCacheTtlSec);
}

function setFriendsListCacheTtlSec(accountId, sec) {
    const current = getAccountConfigSnapshot(accountId);
    const normalized = normalizeFriendsListCacheTtlSec(sec, current.friendsListCacheTtlSec);
    const next = normalizeAccountConfig({
        ...current,
        friendsListCacheTtlSec: normalized,
    }, accountFallbackConfig);
    setAccountConfigSnapshot(accountId, next, true);
    return next.friendsListCacheTtlSec;
}

function getFriendBlacklist(accountId) {
    return [...(getAccountConfigSnapshot(accountId).friendBlacklist || [])];
}

function setFriendBlacklist(accountId, list) {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);
    next.friendBlacklist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
    setAccountConfigSnapshot(accountId, next);
    return [...next.friendBlacklist];
}

function addFriendToBlacklist(accountId, gid) {
    const gidNum = Number(gid);
    if (!gidNum || gidNum <= 0) return false;
    const current = getFriendBlacklist(accountId);
    if (current.includes(gidNum)) return false;
    const newList = [...current, gidNum];
    setFriendBlacklist(accountId, newList);
    return true;
}

// ============ 偷取延迟 ============
function getStealDelaySeconds(accountId) {
    return Math.max(0, Math.min(300, Number(getAccountConfigSnapshot(accountId).stealDelaySeconds) || 0));
}

// ============ 种植顺序随机 ============
function getPlantOrderRandom(accountId) {
    return !!getAccountConfigSnapshot(accountId).plantOrderRandom;
}

// ============ 种植延迟 ============
function getPlantDelaySeconds(accountId) {
    return Math.max(0, Math.min(60, Number(getAccountConfigSnapshot(accountId).plantDelaySeconds) || 0));
}

// ============ 有机化肥购买数量 ============
function getFertilizerBuyOrganicCount(accountId) {
    return Math.max(0, Math.min(10000, Number(getAccountConfigSnapshot(accountId).fertilizerBuyOrganicCount) || 0));
}

// ============ 有机化肥自动购买触发阈值 ============
function getFertilizerBuyOrganicThresholdHours(accountId) {
    return Math.max(0, Math.min(990, Number(getAccountConfigSnapshot(accountId).fertilizerBuyOrganicThresholdHours) || 0));
}

// ============ 无机化肥购买数量 ============
function getFertilizerBuyNormalCount(accountId) {
    return Math.max(0, Math.min(10000, Number(getAccountConfigSnapshot(accountId).fertilizerBuyNormalCount) || 0));
}

// ============ 无机化肥自动购买触发阈值 ============
function getFertilizerBuyNormalThresholdHours(accountId) {
    return Math.max(0, Math.min(990, Number(getAccountConfigSnapshot(accountId).fertilizerBuyNormalThresholdHours) || 0));
}

// ============ 化肥自动购买检测间隔 ============
function getFertilizerBuyCheckIntervalMinutes(accountId) {
    return Math.max(1, Math.min(1440, Number(getAccountConfigSnapshot(accountId).fertilizerBuyCheckIntervalMinutes) || 30));
}

// ============ 蔬菜黑名单 ============
function getPlantBlacklist(accountId) {
    return [...(getAccountConfigSnapshot(accountId).plantBlacklist || [])];
}

function setPlantBlacklist(accountId, list) {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);
    next.plantBlacklist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
    setAccountConfigSnapshot(accountId, next);
    return [...next.plantBlacklist];
}

function getUI() {
    return { ...globalConfig.ui };
}

function setUITheme(theme) {
    const t = String(theme || '').toLowerCase();
    const next = (t === 'light') ? 'light' : 'dark';
    return applyConfigSnapshot({ ui: { theme: next } });
}

// ============ 用户隔离的下线提醒配置 ============
function getOfflineReminder(username) {
    // 必须指定用户名，按用户隔离
    if (!username) {
        return normalizeOfflineReminder(globalConfig.offlineReminder);
    }
    const userCfg = globalConfig.userOfflineReminders && globalConfig.userOfflineReminders[username];
    if (userCfg) {
        return normalizeOfflineReminder(userCfg);
    }
    // 用户未设置时返回默认配置（但不保存到全局）
    return normalizeOfflineReminder({});
}

function setOfflineReminder(cfg, username) {
    // 必须指定用户名，按用户隔离
    if (!username) {
        // 兼容旧版本：如果没有指定用户名，保存到全局配置
        const current = normalizeOfflineReminder(globalConfig.offlineReminder);
        globalConfig.offlineReminder = normalizeOfflineReminder({ ...current, ...(cfg || {}) });
        saveGlobalConfig();
        return getOfflineReminder();
    }
    if (!globalConfig.userOfflineReminders) {
        globalConfig.userOfflineReminders = {};
    }
    const current = normalizeOfflineReminder(globalConfig.userOfflineReminders[username] || {});
    globalConfig.userOfflineReminders[username] = normalizeOfflineReminder({ ...current, ...(cfg || {}) });
    saveGlobalConfig();
    return getOfflineReminder(username);
}

function deleteUserOfflineReminder(username) {
    if (globalConfig.userOfflineReminders && globalConfig.userOfflineReminders[username]) {
        delete globalConfig.userOfflineReminders[username];
        saveGlobalConfig();
    }
}

// ============ 账号管理 ============
function loadAccounts() {
    ensureDataDir();
    const data = readJsonFile(ACCOUNTS_FILE, () => ({ accounts: [], nextId: 1 }));
    return normalizeAccountsData(data);
}

function saveAccounts(data) {
    ensureDataDir();
    writeJsonFileAtomic(ACCOUNTS_FILE, normalizeAccountsData(data));
}

function getAccounts() {
    return loadAccounts();
}

function normalizeAccountsData(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const maxId = accounts.reduce((m, a) => Math.max(m, Number.parseInt(a && a.id, 10) || 0), 0);
    let nextId = Number.parseInt(data.nextId, 10);
    if (!Number.isFinite(nextId) || nextId <= 0) nextId = maxId + 1;
    if (accounts.length === 0) nextId = 1;
    if (nextId <= maxId) nextId = maxId + 1;
    return { accounts, nextId };
}

function addOrUpdateAccount(acc) {
    const data = normalizeAccountsData(loadAccounts());
    let touchedAccountId = '';
    if (acc.id) {
        const idx = data.accounts.findIndex(a => a.id === acc.id);
        if (idx >= 0) {
            data.accounts[idx] = { ...data.accounts[idx], ...acc, name: acc.name !== undefined ? acc.name : data.accounts[idx].name, updatedAt: Date.now() };
            touchedAccountId = String(data.accounts[idx].id || '');
        }
    } else {
        const id = data.nextId++;
        touchedAccountId = String(id);
        data.accounts.push({
            id: touchedAccountId,
            name: acc.name || `账号${id}`,
            code: acc.code || '',
            platform: acc.platform || 'qq',
            uin: acc.uin ? String(acc.uin) : '',
            qq: acc.qq ? String(acc.qq) : (acc.uin ? String(acc.uin) : ''),
            wxid: acc.wxid ? String(acc.wxid) : '',
            loginBuffer: acc.loginBuffer || '', // 微信登录凭证（扫码 confirm 时保存，用于自动刷新 code）
            avatar: acc.avatar || acc.avatarUrl || '',
            username: acc.username || '', // 保存用户名字段
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
    }
    saveAccounts(data);
    if (touchedAccountId) {
        ensureAccountConfig(touchedAccountId);
    }
    return data;
}

function deleteAccount(id) {
    const data = normalizeAccountsData(loadAccounts());
    data.accounts = data.accounts.filter(a => a.id !== String(id));
    if (data.accounts.length === 0) {
        data.nextId = 1;
    }
    saveAccounts(data);
    removeAccountConfig(id);
    return data;
}

// ============ 用户隔离支持 ============
function getAccountsByUser(username) {
    const allAccounts = loadAccounts();
    if (!username) return allAccounts;
    return {
        accounts: allAccounts.accounts.filter(a => a.username === username),
        nextId: allAccounts.nextId
    };
}

function deleteAccountsByUser(username) {
    const data = loadAccounts();
    const deletedIds = [];
    data.accounts = data.accounts.filter(a => {
        if (a.username === username) {
            deletedIds.push(a.id);
            return false;
        }
        return true;
    });
    if (data.accounts.length === 0) {
        data.nextId = 1;
    }
    saveAccounts(data);
    // 清理被删除账号的配置
    deletedIds.forEach(id => removeAccountConfig(id));
    return { deletedCount: deletedIds.length, deletedIds };
}

function deleteUserConfig(username) {
    // 删除用户特定的配置
    deleteUserOfflineReminder(username);
}

function getDefaultAccountConfig() {
    return cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG);
}

// ============ 公告管理 ============
function getAnnouncement() {
    return {
        content: globalConfig.announcement?.content || '',
        showOnce: globalConfig.announcement?.showOnce ?? true,
        updatedAt: globalConfig.announcement?.updatedAt || 0,
    };
}

function setAnnouncement(content, showOnce = true) {
    globalConfig.announcement = {
        content: String(content || '').trim(),
        showOnce: !!showOnce,
        updatedAt: Date.now(),
    };
    saveGlobalConfig();
    return getAnnouncement();
}

function getAnnouncementReadRecord(username) {
    if (!username) return 0;
    return globalConfig.announcementReadRecords?.[username] || 0;
}

function markAnnouncementRead(username) {
    if (!username) return;
    if (!globalConfig.announcementReadRecords) {
        globalConfig.announcementReadRecords = {};
    }
    globalConfig.announcementReadRecords[username] = Date.now();
    saveGlobalConfig();
}

function shouldShowAnnouncement(username) {
    const announcement = getAnnouncement();
    if (!announcement.content) return false;
    if (!username) return false;
    if (!announcement.showOnce) return true;
    const readAt = getAnnouncementReadRecord(username);
    return readAt < announcement.updatedAt;
}

function getSystemConfig() {
    return globalConfig.systemConfig ? { ...globalConfig.systemConfig } : null;
}

function setSystemConfig(config) {
    if (!config || typeof config !== 'object') return null;
    globalConfig.systemConfig = {
        serverUrl: String(config.serverUrl || '').trim(),
        clientVersion: String(config.clientVersion || '').trim(),
        platform: String(config.platform || 'qq').trim(),
        os: String(config.os || 'iOS').trim(),
        versionPrefix: String(config.versionPrefix || '').trim(),
    };
    saveGlobalConfig();
    return { ...globalConfig.systemConfig };
}

// ============ 客户端版本前缀（服务端 version_info 自动校准，持久化跨重启） ============
function getVersionPrefix() {
    return (globalConfig.systemConfig && globalConfig.systemConfig.versionPrefix) || '';
}

function setVersionPrefix(prefix) {
    const t = String(prefix || '').trim();
    if (!t) return '';
    if (!globalConfig.systemConfig) globalConfig.systemConfig = {};
    globalConfig.systemConfig.versionPrefix = t;
    saveGlobalConfig();
    return t;
}

const DEFAULT_WX_CONFIG = {
    enabled: true,
    apiBase: '/api',
    apiKey: '',
    proxyApiUrl: 'http://127.0.0.1:8059/api',
    appId: 'wx5306c5978fdb76e4',
    autoAddAccount: true,
    userIsolation: true,
};

function getGlobalWxConfig() {
    return globalConfig.globalWxConfig ? { ...globalConfig.globalWxConfig } : { ...DEFAULT_WX_CONFIG };
}

function setGlobalWxConfig(config) {
    if (!config || typeof config !== 'object') return null;
    globalConfig.globalWxConfig = {
        enabled: config.enabled !== false,
        apiBase: String(config.apiBase || DEFAULT_WX_CONFIG.apiBase).trim(),
        apiKey: String(config.apiKey || '').trim(),
        proxyApiUrl: String(config.proxyApiUrl || DEFAULT_WX_CONFIG.proxyApiUrl).trim(),
        appId: String(config.appId || DEFAULT_WX_CONFIG.appId).trim(),
        autoAddAccount: config.autoAddAccount !== false,
        userIsolation: config.userIsolation !== false,
    };
    saveGlobalConfig();
    return { ...globalConfig.globalWxConfig };
}

module.exports = {
    getConfigSnapshot,
    applyConfigSnapshot,
    getAutomation,
    setAutomation,
    isAutomationOn,
    getPreferredSeed,
    getPlantingStrategy,
    getBagSeedPriority,
    getBagSeedFallbackStrategy,
    getIntervals,
    getFriendQuietHours,
    getAutoRelogin,
    getVersionPrefix,
    setVersionPrefix,
    getKnownFriendGids,
    setKnownFriendGids,
    getKnownFriendGidSyncCooldownSec,
    setKnownFriendGidSyncCooldownSec,
    getFriendsListCacheTtlSec,
    setFriendsListCacheTtlSec,
    getFriendBlacklist,
    setFriendBlacklist,
    addFriendToBlacklist,
    getStealDelaySeconds,
    getPlantOrderRandom,
    getPlantDelaySeconds,
    getFertilizerBuyOrganicCount,
    getFertilizerBuyOrganicThresholdHours,
    getFertilizerBuyNormalCount,
    getFertilizerBuyNormalThresholdHours,
    getFertilizerBuyCheckIntervalMinutes,
    getUI,
    setUITheme,
    getOfflineReminder,
    setOfflineReminder,
    deleteUserOfflineReminder,
    getAccounts,
    addOrUpdateAccount,
    deleteAccount,
    getAdminPasswordHash,
    setAdminPasswordHash,
    // 用户隔离支持
    getAccountsByUser,
    deleteAccountsByUser,
    deleteUserConfig,
    // 蔬菜黑名单
    getPlantBlacklist,
    setPlantBlacklist,
    // 默认配置
    getDefaultAccountConfig,
    // 公告管理
    getAnnouncement,
    setAnnouncement,
    getAnnouncementReadRecord,
    markAnnouncementRead,
    shouldShowAnnouncement,
    // 系统配置
    getSystemConfig,
    setSystemConfig,
    // 全局微信配置
    getGlobalWxConfig,
    setGlobalWxConfig,
    DEFAULT_WX_CONFIG,
};
