import type { AccountId, AccountRecord } from '../types/domain';

const { sleep } = require('../utils/utils');

type DynamicRecord = Record<string, any>;

interface LoginStatus {
    status?: 'Wait' | 'Used' | 'OK' | string;
    ticket?: unknown;
    uin?: unknown;
}

interface MiniProgramLoginSessionLike {
    queryStatus: (code: string) => Promise<LoginStatus | null>;
    getAuthCode: (ticket: string, appId: string) => Promise<string | null>;
    requestLoginCode: () => Promise<DynamicRecord>;
}

interface WorkerControls {
    startWorker?: (account: AccountRecord) => unknown;
    restartWorker?: (account: AccountRecord) => unknown;
}

interface ReloginReminderOptions {
    store: Record<string, (...args: any[]) => any>;
    miniProgramLoginSession: MiniProgramLoginSessionLike;
    sendPushooMessage: (payload: DynamicRecord) => Promise<DynamicRecord>;
    log: (tag: string, message: string, extra?: DynamicRecord) => void;
    addAccountLog: (action: string, message: string, accountId?: AccountId | '', accountName?: string, extra?: DynamicRecord) => void;
    getAccounts: () => { accounts?: AccountRecord[] };
    addOrUpdateAccount: (account: DynamicRecord) => { accounts?: AccountRecord[] };
    resolveWorkerControls: () => WorkerControls;
}

interface ReloginCodePayload {
    accountId?: AccountId | '';
    accountName?: string;
    authCode?: string;
    uin?: string;
}

interface ReloginWatcherPayload {
    loginCode: string;
    accountId?: AccountId | '';
    accountName?: string;
}

interface OfflineReminderPayload extends DynamicRecord {
    accountId?: AccountId | '';
    accountName?: string;
    reason?: string;
}

export interface ReloginReminderService {
    getOfflineAutoDeleteMs: (username?: string) => number;
    triggerOfflineReminder: (payload?: OfflineReminderPayload) => Promise<void>;
    startReloginWatcher: (payload: ReloginWatcherPayload) => void;
    applyReloginCode: (payload: ReloginCodePayload) => void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

function createReloginReminderService(options: ReloginReminderOptions): ReloginReminderService {
    const {
        store,
        miniProgramLoginSession,
        sendPushooMessage,
        log,
        addAccountLog,
        getAccounts,
        addOrUpdateAccount,
        resolveWorkerControls,
    } = options;

    const reloginWatchers = new Map<string, { startedAt: number }>(); // key: accountId:loginCode

    function getOfflineAutoDeleteMs(username = ''): number {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder(username) : null;
        const sec = Math.max(0, Number.parseInt(String(cfg && cfg.offlineDeleteSec || ''), 10) || 0);
        if (sec === 0) return Infinity;
        return sec * 1000;
    }

    function applyReloginCode({ accountId = '', accountName = '', authCode = '', uin = '' }: ReloginCodePayload): void {
        const code = String(authCode || '').trim();
        if (!code) return;

        const data = getAccounts();
        const list = Array.isArray(data.accounts) ? data.accounts : [];
        const found = list.find((account: AccountRecord) => String(account.id) === String(accountId));
        const avatar = uin ? `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640` : '';
        const controls = (typeof resolveWorkerControls === 'function') ? (resolveWorkerControls() || {}) : {};
        const startWorker = typeof controls.startWorker === 'function' ? controls.startWorker : null;
        const restartWorker = typeof controls.restartWorker === 'function' ? controls.restartWorker : null;

        if (found) {
            addOrUpdateAccount({
                id: found.id,
                name: found.name,
                code,
                platform: found.platform || 'qq',
                qq: uin || found.qq || found.uin || '',
                uin: uin || found.uin || found.qq || '',
                avatar: avatar || found.avatar || '',
            });
            if (restartWorker) {
                restartWorker({
                    ...found,
                    code,
                    qq: uin || found.qq || found.uin || '',
                    uin: uin || found.uin || found.qq || '',
                    avatar: avatar || found.avatar || '',
                });
            }
            addAccountLog('update', `重登录成功，已更新账号: ${found.name}`, found.id, found.name, { reason: 'relogin' });
            log('系统', `重登录成功，账号已更新并重启: ${found.name}`);
            return;
        }

        const created = addOrUpdateAccount({
            name: accountName || (uin ? String(uin) : '重登录账号'),
            code,
            platform: 'qq',
            qq: uin || '',
            uin: uin || '',
            avatar,
        });
        const createdAccounts = created.accounts || [];
        const newAcc = createdAccounts[createdAccounts.length - 1];
        if (newAcc) {
            if (startWorker) startWorker(newAcc);
            addAccountLog('add', `重登录成功，已新增账号: ${newAcc.name}`, newAcc.id, newAcc.name, { reason: 'relogin' });
            log('系统', `重登录成功，已新增账号并启动: ${newAcc.name}`, { accountId: String(newAcc.id), accountName: newAcc.name });
        }
    }

    function startReloginWatcher({ loginCode, accountId = '', accountName = '' }: ReloginWatcherPayload): void {
        const code = String(loginCode || '').trim();
        if (!code) return;

        const key = `${accountId || 'unknown'}:${code}`;
        if (reloginWatchers.has(key)) return;
        reloginWatchers.set(key, { startedAt: Date.now() });
        log('系统', `已启动重登录监听: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || ''), accountName: accountName || '' });

        let stopped = false;
        const stop = (): void => {
            if (stopped) return;
            stopped = true;
            reloginWatchers.delete(key);
        };

        (async () => {
            const maxRounds = 120; // ~2分钟
            for (let i = 0; i < maxRounds; i += 1) {
                try {
                    const status = await miniProgramLoginSession.queryStatus(code);
                    if (!status || status.status === 'Wait') {
                        await sleep(1000);
                        continue;
                    }
                    if (status.status === 'Used') {
                        log('系统', `重登录二维码已失效: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || ''), accountName: accountName || '' });
                        stop();
                        return;
                    }
                    if (status.status === 'OK') {
                        const ticket = String(status.ticket || '').trim();
                        const uin = String(status.uin || '').trim();
                        if (!ticket) {
                            log('错误', '重登录监听失败: ticket 为空');
                            stop();
                            return;
                        }
                        const authCode = await miniProgramLoginSession.getAuthCode(ticket, '1112386029');
                        if (!authCode) {
                            log('错误', '重登录监听失败: 未获取到新 code');
                            stop();
                            return;
                        }
                        applyReloginCode({ accountId, accountName, authCode, uin });
                        stop();
                        return;
                    }
                    await sleep(1000);
                } catch {
                    await sleep(1000);
                }
            }
            log('系统', `重登录监听超时: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || ''), accountName: accountName || '' });
            stop();
        })();
    }

    async function triggerOfflineReminder(payload: OfflineReminderPayload = {}): Promise<void> {
        try {
            const accountId = String(payload.accountId || '').trim();
            const accountName = String(payload.accountName || '').trim();
            const reason = String(payload.reason || 'unknown');

            log('系统', `触发下线提醒: 账号=${accountName || accountId}, 原因=${reason}`, {
                accountId,
                accountName,
                reason,
            });

            // 查找账号对应的用户名
            let username = '';
            try {
                const data = getAccounts();
                const accounts = Array.isArray(data.accounts) ? data.accounts : [];
                const acc = accounts.find((account: AccountRecord) => String(account.id) === accountId);
                if (acc && acc.username) {
                    username = String(acc.username).trim();
                }
            } catch (e) {
                log('错误', `查找账号用户名失败: ${errorMessage(e)}`);
            }

            const cfg = store.getOfflineReminder ? store.getOfflineReminder(username) : null;
            if (!cfg) {
                log('错误', `未找到下线提醒配置: 用户=${username || '(空)'}`);
                return;
            }

            log('系统', `下线提醒配置: 渠道=${cfg.channel}, 标题=${cfg.title}`, {
                channel: cfg.channel,
                title: cfg.title,
                username,
            });

            const channelName = String(cfg.channel || '').trim().toLowerCase();
            const reloginUrlMode = String(cfg.reloginUrlMode || 'none').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const channel = channelName;
            const token = String(cfg.token || '').trim();
            const baseTitle = String(cfg.title || '').trim();
            const title = accountName ? `${baseTitle} ${accountName}` : baseTitle;
            let content = String(cfg.msg || '').trim();
            if (!channel || !token || !title || !content) {
                log('错误', `下线提醒配置不完整: channel=${channel}, token=${token ? '已设置' : '未设置'}, title=${title}, content=${content}`);
                return;
            }
            if (channel === 'webhook' && !endpoint) {
                log('错误', 'Webhook 渠道未设置接口地址');
                return;
            }
            if (reloginUrlMode === 'qq_link' || reloginUrlMode === 'qr_link') {
                try {
                    const qr = await miniProgramLoginSession.requestLoginCode();
                    const loginCode = String((qr && qr.code) || '').trim();
                    const qqUrl = String((qr && (qr.url || qr.loginUrl)) || '').trim();
                    const qrCodeUrl = String((qr && qr.qrcode) || '').trim();
                    if (qqUrl) {
                        if (reloginUrlMode === 'qq_link') {
                            content = `${content}\n\n重登录链接: ${qqUrl}`;
                        } else {
                            const qrcodeText = qrCodeUrl || qqUrl;
                            content = `${content}\n\n重登录二维码链接: ${qrcodeText}`;
                        }
                    }
                    if (loginCode) {
                        startReloginWatcher({
                            loginCode,
                            accountId: String(payload.accountId || '').trim(),
                            accountName: String(payload.accountName || '').trim(),
                        });
                    }
                } catch (e) {
                    log('错误', `获取重登录链接失败: ${errorMessage(e)}`);
                }
            }

            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                title,
                content,
            });

            if (ret && ret.ok) {
                const accountName = String(payload.accountName || payload.accountId || '');
                log('系统', `下线提醒发送成功: ${accountName}`);
            } else {
                log('错误', `下线提醒发送失败: ${ret && ret.msg ? ret.msg : 'unknown'}`);
            }
        } catch (e) {
            log('错误', `下线提醒发送异常: ${errorMessage(e)}`);
        }
    }

    return {
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        startReloginWatcher,
        applyReloginCode,
    };
}

export { createReloginReminderService };
