import process from 'node:process';
import { ensureDataDir, getDataFile } from '../config/runtime-paths';
import { readJsonFile, readTextFile, writeJsonFileAtomic } from '../services/json-db';
import {
    
    cloneAccountConfig,
    DEFAULT_ACCOUNT_CONFIG,
    DEFAULT_FERTILIZER_LAND_TYPES,
    DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
    DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    DEFAULT_OFFLINE_REMINDER,
    normalizeAccountConfig,
    normalizeBagSeedFallbackStrategy,
    normalizeFertilizerLandTypes,
    normalizeFriendsListCacheTtlSec,
    normalizeKnownFriendGids,
    normalizeKnownFriendGidSyncCooldownSec,
    normalizeOfflineReminder
    
} from './account-config';
import type {AccountConfig, OfflineReminderConfig} from './account-config';
import {
    
    createAccountRepository,
    normalizeAccountsData
    
} from './account-repository';
import type {AccountsData, StoredAccount} from './account-repository';
import { createKnownFriendCache } from './known-friend-cache';
/**
 * 运行时存储 - 自动化开关、种子偏好、账号管理
 */

const STORE_FILE = getDataFile('store.json');
const { loadAccounts, saveAccounts } = createAccountRepository({
    ensureDataDir,
    getDataFile,
    readJsonFile,
    writeJsonFileAtomic,
});
const knownFriendCache = createKnownFriendCache({ getDataFile, readJsonFile, writeJsonFileAtomic });
const readKnownFriendGidsCache = knownFriendCache.read;
const writeKnownFriendGidsCache = knownFriendCache.write;

type UnknownRecord = Record<string, unknown>;

interface SystemConfig {
    serverUrl?: string;
    clientVersion?: string;
    platform?: string;
    os?: string;
    versionPrefix?: string;
}

interface WxConfig {
    enabled: boolean;
    autoAddAccount: boolean;
    userIsolation: boolean;
}

interface GlobalConfig {
    accountConfigs: Record<string, AccountConfig>;
    defaultAccountConfig: AccountConfig;
    ui: { theme: string };
    offlineReminder: OfflineReminderConfig;
    userOfflineReminders: Record<string, OfflineReminderConfig>;
    adminPasswordHash: string;
    announcement: { content: string; showOnce: boolean; updatedAt: number };
    announcementReadRecords: Record<string, number>;
    systemConfig: SystemConfig | null;
    globalWxConfig: WxConfig | null;
}

function asRecord(value: unknown): UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : {};
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

let accountFallbackConfig: AccountConfig = {
    ...DEFAULT_ACCOUNT_CONFIG,
    // automation: { ...DEFAULT_ACCOUNT_CONFIG.automation },
    automation: { ...DEFAULT_ACCOUNT_CONFIG.automation, fertilizer_land_types: [...DEFAULT_FERTILIZER_LAND_TYPES] },
    intervals: { ...DEFAULT_ACCOUNT_CONFIG.intervals },
    friendQuietHours: { ...DEFAULT_ACCOUNT_CONFIG.friendQuietHours },
    knownFriendGids: [],
    knownFriendGidSyncCooldownSec: DEFAULT_KNOWN_FRIEND_GID_SYNC_COOLDOWN_SEC,
    friendsListCacheTtlSec: DEFAULT_FRIENDS_LIST_CACHE_TTL_SEC,
};

const globalConfig: GlobalConfig = {
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

function resolveAccountId(accountId: unknown): string {
    const direct = (accountId !== undefined && accountId !== null) ? String(accountId).trim() : '';
    if (direct) return direct;
    const envId = String(process.env.FARM_ACCOUNT_ID || '').trim();
    return envId;
}

function getAccountConfigSnapshot(accountId: unknown): AccountConfig {
    const id = resolveAccountId(accountId);
    if (!id) return cloneAccountConfig(accountFallbackConfig);
    return normalizeAccountConfig(globalConfig.accountConfigs[id], accountFallbackConfig);
}

function setAccountConfigSnapshot(accountId: unknown, nextConfig: unknown, persist = true): AccountConfig {
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

function removeAccountConfig(accountId: unknown): void {
    const id = resolveAccountId(accountId);
    if (!id) return;
    if (globalConfig.accountConfigs[id]) {
        delete globalConfig.accountConfigs[id];
        saveGlobalConfig();
    }
}

function ensureAccountConfig(accountId: unknown, options: { persist?: boolean } = {}): AccountConfig | null {
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
function loadGlobalConfig(): void {
    ensureDataDir();
    try {
        const data = readJsonFile<UnknownRecord>(STORE_FILE, () => ({}));
        if (data && typeof data === 'object') {
            // 先设置 accountFallbackConfig 为默认值，确保后续规范化使用正确的 fallback
            accountFallbackConfig = cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG);
            globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);

            // 加载账号配置，使用 DEFAULT_ACCOUNT_CONFIG 作为 fallback
            const cfgMap = asRecord(data.accountConfigs);
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
            globalConfig.ui = { ...globalConfig.ui, ...asRecord(data.ui) };
            const theme = String(globalConfig.ui.theme || '').toLowerCase();
            globalConfig.ui.theme = theme === 'light' ? 'light' : 'dark';
            globalConfig.offlineReminder = normalizeOfflineReminder(data.offlineReminder);

            // 加载用户隔离的下线提醒配置
            if (data.userOfflineReminders && typeof data.userOfflineReminders === 'object') {
                globalConfig.userOfflineReminders = {};
                for (const [username, cfg] of Object.entries(asRecord(data.userOfflineReminders))) {
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
                const announcement = asRecord(data.announcement);
                globalConfig.announcement = {
                    content: String(announcement.content || '').trim(),
                    showOnce: announcement.showOnce !== false,
                    updatedAt: Number(announcement.updatedAt) || 0,
                };
            }
            // 加载公告已读记录
            if (data.announcementReadRecords && typeof data.announcementReadRecords === 'object') {
                const records: Record<string, number> = {};
                for (const [username, value] of Object.entries(asRecord(data.announcementReadRecords))) {
                    records[username] = Number(value) || 0;
                }
                globalConfig.announcementReadRecords = records;
            }

            // 加载系统运行配置
            if (data.systemConfig && typeof data.systemConfig === 'object') {
                const systemConfig = asRecord(data.systemConfig);
                globalConfig.systemConfig = {
                    serverUrl: String(systemConfig.serverUrl || '').trim(),
                    clientVersion: String(systemConfig.clientVersion || '').trim(),
                    platform: String(systemConfig.platform || 'qq').trim(),
                    os: String(systemConfig.os || 'iOS').trim(),
                    versionPrefix: String(systemConfig.versionPrefix || '').trim(),
                };
            }

            // 加载全局微信配置
            if (data.globalWxConfig && typeof data.globalWxConfig === 'object') {
                const wxConfig = asRecord(data.globalWxConfig);
                globalConfig.globalWxConfig = {
                    enabled: wxConfig.enabled !== false,
                    autoAddAccount: wxConfig.autoAddAccount !== false,
                    userIsolation: wxConfig.userIsolation !== false,
                };
            }
        }
    } catch (error) {
        console.error('加载配置失败:', errorMessage(error));
    }
}

function sanitizeGlobalConfigBeforeSave(): void {
    // default 配置统一白名单净化
    accountFallbackConfig = normalizeAccountConfig(globalConfig.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG);
    globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);

    // 每个账号配置也统一净化（使用 DEFAULT_ACCOUNT_CONFIG 作为 fallback，确保新账号使用正确的默认值）
    const map = (globalConfig.accountConfigs && typeof globalConfig.accountConfigs === 'object')
        ? globalConfig.accountConfigs
        : {};
    const nextMap: Record<string, AccountConfig> = {};
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
    const nextReminders: Record<string, OfflineReminderConfig> = {};
    for (const [username, cfg] of Object.entries(userReminders)) {
        const u = String(username || '').trim();
        if (!u) continue;
        nextReminders[u] = normalizeOfflineReminder(cfg);
    }
    globalConfig.userOfflineReminders = nextReminders;
}

// 保存全局配置
function saveGlobalConfig(): void {
    ensureDataDir();
    try {
        const oldJson = readTextFile(STORE_FILE, '');

        sanitizeGlobalConfigBeforeSave();
        const newJson = JSON.stringify(globalConfig, null, 2);

        if (oldJson !== newJson) {
            console.warn('[系统] 正在保存配置到:', STORE_FILE);
            writeJsonFileAtomic(STORE_FILE, globalConfig);
        }
    } catch (error) {
        console.error('保存配置失败:', errorMessage(error));
    }
}

function getAdminPasswordHash(): string {
    return String(globalConfig.adminPasswordHash || '');
}

function setAdminPasswordHash(hash: unknown): string {
    globalConfig.adminPasswordHash = String(hash || '');
    saveGlobalConfig();
    return globalConfig.adminPasswordHash;
}

// 初始化加载
loadGlobalConfig();

function getAutomation(accountId: unknown): UnknownRecord {
    // return { ...getAccountConfigSnapshot(accountId).automation };
    const automation = { ...getAccountConfigSnapshot(accountId).automation };
    automation.fertilizer_land_types = normalizeFertilizerLandTypes(automation.fertilizer_land_types);
    return automation;
}

function getConfigSnapshot(accountId: unknown): UnknownRecord {
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

function applyConfigSnapshot(
    snapshot: unknown,
    options: { persist?: boolean; accountId?: unknown } = {},
): UnknownRecord {
    const config = asRecord(snapshot);
    const persist = options.persist !== false;
    const accountId = options.accountId;
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig({
        ...current,
        ...config,
        automation: { ...current.automation, ...asRecord(config.automation) },
        intervals: { ...current.intervals, ...asRecord(config.intervals) },
        friendQuietHours: { ...current.friendQuietHours, ...asRecord(config.friendQuietHours) },
        autoRelogin: { ...current.autoRelogin, ...asRecord(config.autoRelogin) },
    }, accountFallbackConfig);

    if (config.knownFriendGids !== undefined && accountId) {
        writeKnownFriendGidsCache(accountId, next.knownFriendGids);
    }
    const ui = asRecord(config.ui);
    const theme = String(ui.theme || '').toLowerCase();
    if (theme === 'dark' || theme === 'light') globalConfig.ui.theme = theme;

    setAccountConfigSnapshot(accountId, next, false);
    if (persist) saveGlobalConfig();
    return getConfigSnapshot(accountId);
}

function setAutomation(key: string, value: unknown, accountId?: unknown): UnknownRecord {
    return applyConfigSnapshot({ automation: { [key]: value } }, { accountId });
}

function isAutomationOn(key: string, accountId?: unknown): boolean {
    return !!getAccountConfigSnapshot(accountId).automation[key];
}

function getPreferredSeed(accountId?: unknown): number {
    return getAccountConfigSnapshot(accountId).preferredSeedId;
}

function getPlantingStrategy(accountId?: unknown): string {
    return getAccountConfigSnapshot(accountId).plantingStrategy;
}

function getBagSeedPriority(accountId?: unknown): number[] {
    return [...(getAccountConfigSnapshot(accountId).bagSeedPriority || [])];
}

function getBagSeedFallbackStrategy(accountId?: unknown): string {
    return normalizeBagSeedFallbackStrategy(getAccountConfigSnapshot(accountId).bagSeedFallbackStrategy);
}

function getIntervals(accountId?: unknown): Record<string, number> {
    return { ...getAccountConfigSnapshot(accountId).intervals };
}

function getFriendQuietHours(accountId?: unknown): AccountConfig['friendQuietHours'] {
    return { ...getAccountConfigSnapshot(accountId).friendQuietHours };
}

// ============ 自动重登 ============
function getAutoRelogin(accountId?: unknown): AccountConfig['autoRelogin'] {
    return { ...getAccountConfigSnapshot(accountId).autoRelogin };
}

function getKnownFriendGids(accountId?: unknown): number[] {
    const config = getAccountConfigSnapshot(accountId);
    const configGids = config.knownFriendGids || [];
    
    // 如果配置中有 GID，直接返回
    if (configGids.length > 0) {
        return [...configGids];
    }
    
    // 否则尝试从缓存文件读取
    const cachedGids = readKnownFriendGidsCache(accountId);
    if (cachedGids && cachedGids.length > 0) {
        return normalizeKnownFriendGids(cachedGids);
    }
    
    return [];
}

function setKnownFriendGids(accountId: unknown, list: unknown): number[] {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);
    const normalizedGids = normalizeKnownFriendGids(list, next.knownFriendGids);
    next.knownFriendGids = normalizedGids;
    setAccountConfigSnapshot(accountId, next);
    
    // 同时写入缓存文件
    writeKnownFriendGidsCache(accountId, normalizedGids);
    
    return [...normalizedGids];
}

function getKnownFriendGidSyncCooldownSec(accountId?: unknown): number {
    return normalizeKnownFriendGidSyncCooldownSec(getAccountConfigSnapshot(accountId).knownFriendGidSyncCooldownSec);
}

function setKnownFriendGidSyncCooldownSec(accountId: unknown, sec: unknown): number {
    const current = getAccountConfigSnapshot(accountId);
    const normalized = normalizeKnownFriendGidSyncCooldownSec(sec, current.knownFriendGidSyncCooldownSec);
    const next = normalizeAccountConfig({
        ...current,
        knownFriendGidSyncCooldownSec: normalized,
    }, accountFallbackConfig);
    setAccountConfigSnapshot(accountId, next, true);
    return next.knownFriendGidSyncCooldownSec;
}

function getFriendsListCacheTtlSec(accountId?: unknown): number {
    return normalizeFriendsListCacheTtlSec(getAccountConfigSnapshot(accountId).friendsListCacheTtlSec);
}

function setFriendsListCacheTtlSec(accountId: unknown, sec: unknown): number {
    const current = getAccountConfigSnapshot(accountId);
    const normalized = normalizeFriendsListCacheTtlSec(sec, current.friendsListCacheTtlSec);
    const next = normalizeAccountConfig({
        ...current,
        friendsListCacheTtlSec: normalized,
    }, accountFallbackConfig);
    setAccountConfigSnapshot(accountId, next, true);
    return next.friendsListCacheTtlSec;
}

function getFriendBlacklist(accountId?: unknown): number[] {
    return [...(getAccountConfigSnapshot(accountId).friendBlacklist || [])];
}

function setFriendBlacklist(accountId: unknown, list: unknown): number[] {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);
    next.friendBlacklist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
    setAccountConfigSnapshot(accountId, next);
    return [...next.friendBlacklist];
}

function addFriendToBlacklist(accountId: unknown, gid: unknown): boolean {
    const gidNum = Number(gid);
    if (!gidNum || gidNum <= 0) return false;
    const current = getFriendBlacklist(accountId);
    if (current.includes(gidNum)) return false;
    const newList = [...current, gidNum];
    setFriendBlacklist(accountId, newList);
    return true;
}

// ============ 偷取延迟 ============
function getStealDelaySeconds(accountId?: unknown): number {
    return Math.max(0, Math.min(300, Number(getAccountConfigSnapshot(accountId).stealDelaySeconds) || 0));
}

// ============ 种植顺序随机 ============
function getPlantOrderRandom(accountId?: unknown): boolean {
    return !!getAccountConfigSnapshot(accountId).plantOrderRandom;
}

// ============ 种植延迟 ============
function getPlantDelaySeconds(accountId?: unknown): number {
    return Math.max(0, Math.min(60, Number(getAccountConfigSnapshot(accountId).plantDelaySeconds) || 0));
}

// ============ 有机化肥购买数量 ============
function getFertilizerBuyOrganicCount(accountId?: unknown): number {
    return Math.max(0, Math.min(10000, Number(getAccountConfigSnapshot(accountId).fertilizerBuyOrganicCount) || 0));
}

// ============ 有机化肥自动购买触发阈值 ============
function getFertilizerBuyOrganicThresholdHours(accountId?: unknown): number {
    return Math.max(0, Math.min(990, Number(getAccountConfigSnapshot(accountId).fertilizerBuyOrganicThresholdHours) || 0));
}

// ============ 无机化肥购买数量 ============
function getFertilizerBuyNormalCount(accountId?: unknown): number {
    return Math.max(0, Math.min(10000, Number(getAccountConfigSnapshot(accountId).fertilizerBuyNormalCount) || 0));
}

// ============ 无机化肥自动购买触发阈值 ============
function getFertilizerBuyNormalThresholdHours(accountId?: unknown): number {
    return Math.max(0, Math.min(990, Number(getAccountConfigSnapshot(accountId).fertilizerBuyNormalThresholdHours) || 0));
}

// ============ 化肥自动购买检测间隔 ============
function getFertilizerBuyCheckIntervalMinutes(accountId?: unknown): number {
    return Math.max(1, Math.min(1440, Number(getAccountConfigSnapshot(accountId).fertilizerBuyCheckIntervalMinutes) || 30));
}

// ============ 蔬菜黑名单 ============
function getPlantBlacklist(accountId?: unknown): number[] {
    return [...(getAccountConfigSnapshot(accountId).plantBlacklist || [])];
}

function setPlantBlacklist(accountId: unknown, list: unknown): number[] {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);
    next.plantBlacklist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
    setAccountConfigSnapshot(accountId, next);
    return [...next.plantBlacklist];
}

function getUI(): { theme: string } {
    return { ...globalConfig.ui };
}

function setUITheme(theme: unknown): UnknownRecord {
    const t = String(theme || '').toLowerCase();
    const next = (t === 'light') ? 'light' : 'dark';
    return applyConfigSnapshot({ ui: { theme: next } });
}

// ============ 用户隔离的下线提醒配置 ============
function getOfflineReminder(username?: string): OfflineReminderConfig {
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

function setOfflineReminder(cfg: unknown, username?: string): OfflineReminderConfig {
    // 必须指定用户名，按用户隔离
    if (!username) {
        // 兼容旧版本：如果没有指定用户名，保存到全局配置
        const current = normalizeOfflineReminder(globalConfig.offlineReminder);
        globalConfig.offlineReminder = normalizeOfflineReminder({ ...current, ...asRecord(cfg) });
        saveGlobalConfig();
        return getOfflineReminder();
    }
    if (!globalConfig.userOfflineReminders) {
        globalConfig.userOfflineReminders = {};
    }
    const current = normalizeOfflineReminder(globalConfig.userOfflineReminders[username] || {});
    globalConfig.userOfflineReminders[username] = normalizeOfflineReminder({ ...current, ...asRecord(cfg) });
    saveGlobalConfig();
    return getOfflineReminder(username);
}

function deleteUserOfflineReminder(username: string): void {
    if (globalConfig.userOfflineReminders && globalConfig.userOfflineReminders[username]) {
        delete globalConfig.userOfflineReminders[username];
        saveGlobalConfig();
    }
}

// ============ 账号管理 ============
function getAccounts(): AccountsData {
    return loadAccounts();
}

function addOrUpdateAccount(account: unknown): AccountsData {
    const acc = asRecord(account);
    const data = normalizeAccountsData(loadAccounts());
    let touchedAccountId = '';
    if (acc.id) {
        const idx = data.accounts.findIndex((item: StoredAccount) => item.id === acc.id);
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
            refreshtoken: acc.refreshtoken || '', // 微信凭证保活刷新 token（loginBuffer 失效时自动续期）
            accesstoken: acc.accesstoken || '', // 应用宝 access token（凭证刷新请求必需）
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

function deleteAccount(id: unknown): AccountsData {
    const data = normalizeAccountsData(loadAccounts());
    data.accounts = data.accounts.filter((account: StoredAccount) => account.id !== String(id));
    if (data.accounts.length === 0) {
        data.nextId = 1;
    }
    saveAccounts(data);
    removeAccountConfig(id);
    return data;
}

// ============ 用户隔离支持 ============
function getAccountsByUser(username?: string): AccountsData {
    const allAccounts = loadAccounts();
    if (!username) return allAccounts;
    return {
        accounts: allAccounts.accounts.filter((account: StoredAccount) => account.username === username),
        nextId: allAccounts.nextId
    };
}

function deleteAccountsByUser(username: string): { deletedCount: number; deletedIds: unknown[] } {
    const data = loadAccounts();
    const deletedIds: unknown[] = [];
    data.accounts = data.accounts.filter((account: StoredAccount) => {
        if (account.username === username) {
            deletedIds.push(account.id);
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

function deleteUserConfig(username: string): void {
    // 删除用户特定的配置
    deleteUserOfflineReminder(username);
}

function getDefaultAccountConfig(): AccountConfig {
    return cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG);
}

// ============ 公告管理 ============
function getAnnouncement(): GlobalConfig['announcement'] {
    return {
        content: globalConfig.announcement?.content || '',
        showOnce: globalConfig.announcement?.showOnce ?? true,
        updatedAt: globalConfig.announcement?.updatedAt || 0,
    };
}

function setAnnouncement(content: unknown, showOnce = true): GlobalConfig['announcement'] {
    globalConfig.announcement = {
        content: String(content || '').trim(),
        showOnce: !!showOnce,
        updatedAt: Date.now(),
    };
    saveGlobalConfig();
    return getAnnouncement();
}

function getAnnouncementReadRecord(username?: string): number {
    if (!username) return 0;
    return globalConfig.announcementReadRecords?.[username] || 0;
}

function markAnnouncementRead(username?: string): void {
    if (!username) return;
    if (!globalConfig.announcementReadRecords) {
        globalConfig.announcementReadRecords = {};
    }
    globalConfig.announcementReadRecords[username] = Date.now();
    saveGlobalConfig();
}

function shouldShowAnnouncement(username?: string): boolean {
    const announcement = getAnnouncement();
    if (!announcement.content) return false;
    if (!username) return false;
    if (!announcement.showOnce) return true;
    const readAt = getAnnouncementReadRecord(username);
    return readAt < announcement.updatedAt;
}

function getSystemConfig(): SystemConfig | null {
    return globalConfig.systemConfig ? { ...globalConfig.systemConfig } : null;
}

function setSystemConfig(config: unknown): SystemConfig | null {
    if (!config || typeof config !== 'object') return null;
    const source = asRecord(config);
    globalConfig.systemConfig = {
        serverUrl: String(source.serverUrl || '').trim(),
        clientVersion: String(source.clientVersion || '').trim(),
        platform: String(source.platform || 'qq').trim(),
        os: String(source.os || 'iOS').trim(),
        versionPrefix: String(source.versionPrefix || '').trim(),
    };
    saveGlobalConfig();
    return { ...globalConfig.systemConfig };
}

// ============ 客户端版本前缀（服务端 version_info 自动校准，持久化跨重启） ============
function getVersionPrefix(): string {
    return (globalConfig.systemConfig && globalConfig.systemConfig.versionPrefix) || '';
}

function setVersionPrefix(prefix: unknown): string {
    const t = String(prefix || '').trim();
    if (!t) return '';
    if (!globalConfig.systemConfig) globalConfig.systemConfig = {};
    globalConfig.systemConfig.versionPrefix = t;
    saveGlobalConfig();
    return t;
}

const DEFAULT_WX_CONFIG: WxConfig = {
    enabled: true,
    autoAddAccount: true,
    userIsolation: true,
};

function getGlobalWxConfig(): WxConfig {
    return globalConfig.globalWxConfig ? { ...globalConfig.globalWxConfig } : { ...DEFAULT_WX_CONFIG };
}

function setGlobalWxConfig(config: unknown): WxConfig | null {
    if (!config || typeof config !== 'object') return null;
    const source = asRecord(config);
    globalConfig.globalWxConfig = {
        enabled: source.enabled !== false,
        autoAddAccount: source.autoAddAccount !== false,
        userIsolation: source.userIsolation !== false,
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
