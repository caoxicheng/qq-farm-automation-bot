const process = require('node:process');
/**
 * 配置常量与枚举定义
 */

const DEFAULT_SYSTEM_CONFIG = {
    serverUrl: 'wss://gate-obt.nqf.qq.com/prod/ws',
    clientVersion: '1.11.1.7_20260803',
    platform: 'qq',
    os: 'iOS',
};

// 客户端版本前缀（游戏真实版本号）。日期部分自动取当天，无需手动更新。
// 前缀会被服务端下发的版本信息（version_info）自动校准，见 network.js 的 applyServerVersionInfo。
const CLIENT_VERSION_PREFIX = '1.11.1.7';
let runtimeVersionPrefix = CLIENT_VERSION_PREFIX;

function setClientVersionPrefix(prefix) {
    const t = String(prefix || '').trim();
    if (t) runtimeVersionPrefix = t;
}

function getVersionPrefix() {
    return runtimeVersionPrefix;
}

// 自动重登默认配置（账号级，可在 Web 面板按账号覆盖）
const DEFAULT_AUTO_RELOGIN = {
    enabled: false,          // 默认关闭，需手动开启
    delayMinutes: 15,        // 被踢后延迟重登（分钟）
    maxPerDay: 3,            // 每日自动重登上限
    kickWindowMinutes: 10,   // 重登后 N 分钟内再被踢 = 手机还在玩 → 禁用当天自动重登
    loginFailWindowSec: 60,  // 重登后 N 秒内未登录成功（进程退出） = 登录失败 → 禁用当天自动重登
};

function pad2(n) {
    return String(n).padStart(2, '0');
}

// 动态生成客户端版本号：前缀（可被服务端校准）_ 当天日期（自动）
function getClientVersion() {
    const d = new Date();
    const ymd = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
    return `${runtimeVersionPrefix}_${ymd}`;
}

const CONFIG = {
    serverUrl: DEFAULT_SYSTEM_CONFIG.serverUrl,
    clientVersion: DEFAULT_SYSTEM_CONFIG.clientVersion,
    platform: DEFAULT_SYSTEM_CONFIG.platform,
    os: DEFAULT_SYSTEM_CONFIG.os,
    heartbeatInterval: 25000,
    farmCheckInterval: 3000,
    friendCheckInterval: 12000,
    farmCheckIntervalMin: 3000,
    farmCheckIntervalMax: 5000,
    friendCheckIntervalMin: 12000,
    friendCheckIntervalMax: 15000,
    adminPort: Number(process.env.ADMIN_PORT),
    adminPassword: process.env.ADMIN_PASSWORD,
};

function updateRuntimeConfig(newConfig) {
    if (newConfig.serverUrl && typeof newConfig.serverUrl === 'string') {
        CONFIG.serverUrl = newConfig.serverUrl;
    }
    if (newConfig.clientVersion && typeof newConfig.clientVersion === 'string') {
        CONFIG.clientVersion = newConfig.clientVersion;
    }
    if (newConfig.platform && typeof newConfig.platform === 'string') {
        CONFIG.platform = newConfig.platform;
    }
    if (newConfig.os && typeof newConfig.os === 'string') {
        CONFIG.os = newConfig.os;
    }
}

function getRuntimeConfig() {
    return {
        serverUrl: CONFIG.serverUrl,
        clientVersion: CONFIG.clientVersion,
        platform: CONFIG.platform,
        os: CONFIG.os,
    };
}

function getDefaultSystemConfig() {
    return { ...DEFAULT_SYSTEM_CONFIG };
}

// 生长阶段枚举
const PlantPhase = {
    UNKNOWN: 0,
    SEED: 1,
    GERMINATION: 2,
    SMALL_LEAVES: 3,
    LARGE_LEAVES: 4,
    BLOOMING: 5,
    MATURE: 6,
    DEAD: 7,
};

const PHASE_NAMES = ['未知', '种子', '发芽', '小叶', '大叶', '开花', '成熟', '枯死'];

module.exports = { CONFIG, PlantPhase, PHASE_NAMES, updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig, getClientVersion, setClientVersionPrefix, getVersionPrefix, DEFAULT_AUTO_RELOGIN };
