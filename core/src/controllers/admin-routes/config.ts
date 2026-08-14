import type { Express, Request, RequestHandler } from 'express';
import type { DataProvider } from '../../runtime/data-provider';
import { sendPushooMessage } from '../../services/push';

type DynamicRecord = Record<string, any>;

interface ConfigRouteOptions {
    adminRequired: RequestHandler;
    app: Express;
    authRequired: RequestHandler;
    checkAccountAccess: (request: Request, accountId: unknown) => boolean;
    getAccountId: (request: Request) => string;
    getDefaultSystemConfig: () => unknown;
    getRuntimeConfig: () => DynamicRecord;
    provider: DataProvider;
    store: DynamicRecord;
    updateRuntimeConfig: (config: unknown) => void;
    versionChecker: DynamicRecord;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

function registerConfigRoutes(options: ConfigRouteOptions): void {
    const {
        adminRequired,
        app,
        authRequired,
        checkAccountAccess,
        getAccountId: getAccId,
        getDefaultSystemConfig,
        getRuntimeConfig,
        provider,
        store,
        updateRuntimeConfig,
        versionChecker,
    } = options;

    // API: 设置页统一保存（单次写入+单次广播）
    app.post('/api/settings/save', async (req, res) => {
        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.saveSettings(id, req.body || {});
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // API: 设置面板主题
    app.post('/api/settings/theme', async (req, res) => {
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // API: 保存下线提醒配置
    app.post('/api/settings/offline-reminder', async (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const currentUser = req.currentUser;

            // 必须登录才能保存下线提醒配置
            if (!currentUser) {
                return res.status(401).json({ ok: false, error: '未登录' });
            }

            // 保存到用户隔离的配置中
            const data = store.setOfflineReminder
                ? store.setOfflineReminder(body, currentUser.username)
                : {};
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // API: 测试下线提醒推送（不落盘）
    app.post('/api/settings/offline-reminder/test', async (req, res) => {
        try {
            const currentUser = req.currentUser;
            const saved = store.getOfflineReminder && currentUser
                ? store.getOfflineReminder(currentUser.username)
                : {};
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const cfg = { ...(saved || {}), ...body };

            const channel = String(cfg.channel || '').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const token = String(cfg.token || '').trim();
            const titleBase = String(cfg.title || '账号下线提醒').trim();
            const msgBase = String(cfg.msg || '账号下线').trim();

            if (!channel) {
                return res.status(400).json({ ok: false, error: '推送渠道不能为空' });
            }
            if (channel === 'webhook' && !endpoint) {
                return res.status(400).json({ ok: false, error: 'Webhook 渠道需要填写接口地址' });
            }

            const now = new Date();
            const ts = now.toISOString().replace('T', ' ').slice(0, 19);
            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                title: `${titleBase}（测试）`,
                content: `${msgBase}\n\n这是一条下线提醒测试消息。\n时间: ${ts}`,
            });

            if (!ret) {
                return res.status(400).json({ ok: false, error: '推送失败：无返回结果' });
            }
            
            const isSuccess = ret.ok || 
                ret.code === 'ok' || 
                ret.code === '0' || 
                String(ret.msg || '').includes('成功') ||
                String(ret.raw?.status || '').toLowerCase() === 'success';
            
            if (!isSuccess && ret.msg && !String(ret.msg).includes('成功')) {
                return res.status(400).json({ ok: false, error: ret.msg || '推送失败', data: ret });
            }
            return res.json({ ok: true, data: ret, message: ret.msg || '推送成功' });
        } catch (e) {
            return res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // API: 获取配置
    app.get('/api/settings', async (req, res) => {
        try {
            const id = getAccId(req);
            const currentUser = req.currentUser;

            // 检查权限（如果指定了账号ID）
            if (id && !checkAccountAccess(req, id)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            // 直接从主进程的 store 读取，确保即使账号未运行也能获取配置
            const intervals = id ? store.getIntervals(id) : {};
            const strategy = id ? store.getPlantingStrategy(id) : null;
            const preferredSeed = id ? store.getPreferredSeed(id) : null;
            const friendQuietHours = id ? store.getFriendQuietHours(id) : null;
            const automation = id ? store.getAutomation(id) : {};
            const stealDelaySeconds = id && (typeof store.getStealDelaySeconds === 'function') ? store.getStealDelaySeconds(id) : 0;
            const plantOrderRandom = id && (typeof store.getPlantOrderRandom === 'function') ? store.getPlantOrderRandom(id) : false;
            const plantDelaySeconds = id && (typeof store.getPlantDelaySeconds === 'function') ? store.getPlantDelaySeconds(id) : 0;
            const fertilizerBuyOrganicCount = id && (typeof store.getFertilizerBuyOrganicCount === 'function') ? store.getFertilizerBuyOrganicCount(id) : 0;
            const fertilizerBuyOrganicThresholdHours = id && (typeof store.getFertilizerBuyOrganicThresholdHours === 'function') ? store.getFertilizerBuyOrganicThresholdHours(id) : 10;
            const fertilizerBuyNormalCount = id && (typeof store.getFertilizerBuyNormalCount === 'function') ? store.getFertilizerBuyNormalCount(id) : 0;
            const fertilizerBuyNormalThresholdHours = id && (typeof store.getFertilizerBuyNormalThresholdHours === 'function') ? store.getFertilizerBuyNormalThresholdHours(id) : 10;
            const fertilizerBuyCheckIntervalMinutes = id && (typeof store.getFertilizerBuyCheckIntervalMinutes === 'function') ? store.getFertilizerBuyCheckIntervalMinutes(id) : 30;
            const bagSeedPriority = id && (typeof store.getBagSeedPriority === 'function') ? store.getBagSeedPriority(id) : [];
            const bagSeedFallbackStrategy = id && (typeof store.getBagSeedFallbackStrategy === 'function') ? store.getBagSeedFallbackStrategy(id) : 'level';
            const autoRelogin = id && (typeof store.getAutoRelogin === 'function') ? store.getAutoRelogin(id) : null;
            const ui = store.getUI();
            // 获取用户隔离的下线提醒配置
            const offlineReminder = store.getOfflineReminder && currentUser
                ? store.getOfflineReminder(currentUser.username)
                : { channel: 'webhook', reloginUrlMode: 'none', endpoint: '', token: '', title: '账号下线提醒', msg: '账号下线', offlineDeleteSec: 0 };
            res.json({ ok: true, data: { intervals, strategy, preferredSeed, friendQuietHours, automation, autoRelogin, stealDelaySeconds, plantOrderRandom, plantDelaySeconds, fertilizerBuyOrganicCount, fertilizerBuyOrganicThresholdHours, fertilizerBuyNormalCount, fertilizerBuyNormalThresholdHours, fertilizerBuyCheckIntervalMinutes, bagSeedPriority, bagSeedFallbackStrategy, ui, offlineReminder } });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // API: 获取默认配置
    app.get('/api/settings/default', (req, res) => {
        try {
            const defaultConfig = store.getDefaultAccountConfig ? store.getDefaultAccountConfig() : null;
            if (!defaultConfig) {
                return res.status(500).json({ ok: false, error: '无法获取默认配置' });
            }
            res.json({ ok: true, data: defaultConfig });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    app.get('/api/admin/update-status', authRequired, adminRequired, (req, res) => {
        res.json({ ok: true, data: versionChecker.getStatus() });
    });

    // ============ 公告管理 API ============
    // 获取公告（所有用户可访问）
    app.get('/api/announcement', authRequired, (req, res) => {
        try {
            const currentUser = req.currentUser;
            const announcement = store.getAnnouncement();
            const shouldShow = store.shouldShowAnnouncement(currentUser?.username);
            res.json({
                ok: true,
                data: {
                    ...announcement,
                    shouldShow,
                },
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 标记公告已读
    app.post('/api/announcement/read', authRequired, (req, res) => {
        try {
            const currentUser = req.currentUser;
            if (currentUser?.username) {
                store.markAnnouncementRead(currentUser.username);
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 设置公告（仅管理员）
    app.post('/api/admin/announcement', authRequired, adminRequired, (req, res) => {
        try {
            const { content, showOnce } = req.body || {};
            const announcement = store.setAnnouncement(content, showOnce);
            res.json({ ok: true, data: announcement });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // ============ 系统配置 API（仅管理员） ============

    // 获取系统配置
    app.get('/api/admin/system-config', authRequired, adminRequired, (req, res) => {
        try {
            const savedConfig = store.getSystemConfig();
            const defaultConfig = getDefaultSystemConfig();
            const currentRuntime = getRuntimeConfig();
            res.json({
                ok: true,
                data: {
                    saved: savedConfig,
                    default: defaultConfig,
                    current: currentRuntime,
                },
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 保存系统配置
    app.post('/api/admin/system-config', authRequired, adminRequired, (req, res) => {
        try {
            const { serverUrl, clientVersion, platform, os } = req.body || {};
            const newConfig = { serverUrl, clientVersion, platform, os };
            const saved = store.setSystemConfig(newConfig);
            updateRuntimeConfig(saved);
            const current = getRuntimeConfig();
            res.json({ ok: true, data: { saved, current } });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 重置系统配置为默认值
    app.post('/api/admin/system-config/reset', authRequired, adminRequired, (req, res) => {
        try {
            const defaultConfig = getDefaultSystemConfig();
            store.setSystemConfig(defaultConfig);
            updateRuntimeConfig(defaultConfig);
            const current = getRuntimeConfig();
            res.json({ ok: true, data: { saved: defaultConfig, current } });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // ============ 全局微信配置 API（仅管理员） ============

    // 获取全局微信配置
    app.get('/api/admin/wx-config', authRequired, adminRequired, (req, res) => {
        try {
            const config = store.getGlobalWxConfig();
            res.json({ ok: true, data: config });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // 保存全局微信配置
    app.post('/api/admin/wx-config', authRequired, adminRequired, (req, res) => {
        try {
            const config = req.body || {};
            const saved = store.setGlobalWxConfig(config);
            res.json({ ok: true, data: saved });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

}

export { registerConfigRoutes };

