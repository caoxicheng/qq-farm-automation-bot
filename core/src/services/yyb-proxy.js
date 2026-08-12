const process = require('node:process');
const crypto = require('node:crypto');
/**
 * 微信登录适配层（vxcode 风格接口）
 * 内部实现：纯 Node 进程内应用宝协议（wx-login service，MMTLS），不依赖外部 yyb-go 服务
 * 头像仍走 yyb-go（Docker 场景），本地无 yyb-go 时返回 null（前端隐藏头像）
 */

const fetch = require('node-fetch');
const { createModuleLogger } = require('./logger');
const { WxLoginService } = require('./wx-login/service');
const { getAccounts, addOrUpdateAccount } = require('../models/store');

const logger = createModuleLogger('yyb-proxy');

// 容器内通过 compose 网络访问 yyb-go 服务（仅头像使用），可用环境变量覆盖
const YYB_BASE = process.env.YYB_GO_BASE || 'http://yyb-go:8000';
const YYB_TOKEN = process.env.YYB_API_TOKEN || 'yyb-go-local-token';

// 农场小游戏 appid（与 ACE 反作弊 tsdk MINI_PROGRAM_APP_ID 一致）
const TARGET_APP_ID = 'wx5306c5978fdb76e4';
const WX_SESSION_TTL_MS = 300 * 1000;

const wxLogin = new WxLoginService();

// uuid -> { session, openid, loginBuffer, createdAt }
const wxSessions = new Map();

function findAccountByWxid(openid) {
    if (!openid) return null;
    const list = typeof getAccounts === 'function' ? getAccounts() : { accounts: [] };
    const accounts = Array.isArray(list) ? list : (list.accounts || []);
    return accounts.find(a => a && String(a.wxid || '') === String(openid)) || null;
}

function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [uuid, entry] of wxSessions) {
        if (now - entry.createdAt > WX_SESSION_TTL_MS) wxSessions.delete(uuid);
    }
}

// 从应用宝用户信息响应中取字段（顶层优先，兜底 ext_info.list_s 嵌套）
function pickUserInfoValue(info, keys) {
    if (!info || typeof info !== 'object') return '';
    for (const k of keys) {
        const v = info[k];
        if (typeof v === 'string' && v) return v;
    }
    const nested = info.ext_info && info.ext_info.list_s;
    if (nested && typeof nested === 'object') {
        for (const k of keys) {
            const v = nested[k];
            if (typeof v === 'string' && v) return v;
            if (v && typeof v === 'object' && Array.isArray(v.value)) {
                const first = v.value.find(x => typeof x === 'string' && x);
                if (first) return first;
            }
        }
    }
    return '';
}

// 头像 URL 白名单：仅允许 https 的微信头像域名（qlogo.cn 系），防 SSRF
function isAllowedAvatarUrl(url) {
    if (!/^https:\/\//i.test(url)) return false;
    try {
        const host = new URL(url).hostname;
        return host === 'qlogo.cn' || host.endsWith('.qlogo.cn');
    } catch {
        return false;
    }
}

/**
 * 取待绑定微信账号的扫码会话数据（loginBuffer/头像/昵称）
 * 时序：JSLogin（getFarmCode）在账号创建前被调用，loginBuffer 需在创建账号时补上
 * 返回: { loginBuffer, avatar, nickname } 或 null（无有效会话）
 */
function takePendingWxInfo(openid) {
    if (!openid) return null;
    for (const entry of wxSessions.values()) {
        if (entry.openid === String(openid) && entry.loginBuffer) {
            return {
                loginBuffer: String(entry.loginBuffer),
                refreshtoken: entry.refreshtoken || '',
                accesstoken: entry.accesstoken || '',
                avatar: entry.avatar || '',
                nickname: entry.nickname || '',
            };
        }
    }
    return null;
}

// MMTLS 握手失败错误 → 可读指引（区分凭证失效与网络波动）
function humanizeWxCodeError(raw) {
    const s = String(raw || '');
    if (s.includes('ManualAuth rejected')) {
        return '微信登录凭证已失效，请在面板重新扫码登录';
    }
    if (s.includes('socket read timeout') || s.includes('Unable to establish') || s.includes('invalid HTTP response')) {
        return '无法连接微信服务器（网络波动），请稍后重试；若持续失败请重新扫码登录';
    }
    return s;
}

/**
 * 获取微信登录二维码
 * 返回: { Success, Data: { Uuid, QrBase64 } }
 */
async function getQRCode() {
    cleanupExpiredSessions();
    try {
        const { session, qr } = await wxLogin.createQrSession();
        const uuid = crypto.randomBytes(16).toString('hex');
        wxSessions.set(uuid, { session, createdAt: Date.now() });
        return {
            Success: true,
            Data: {
                Uuid: uuid,
                QrBase64: qr.toString('base64'),
            },
        };
    } catch (e) {
        return { Success: false, Message: `获取二维码失败: ${e.message}` };
    }
}

/**
 * 轮询扫码状态
 * 返回: { Success, Data: { status } } 或 { Success, Data: { acctSectResp } }
 */
async function checkQR(uuid) {
    const entry = wxSessions.get(String(uuid || ''));
    if (!entry || Date.now() - entry.createdAt > WX_SESSION_TTL_MS) {
        if (entry) wxSessions.delete(uuid);
        return { Success: false, Message: '二维码已过期，请重新获取' };
    }
    try {
        const status = await wxLogin.poll(entry.session);
        switch (status) {
            case 'waiting':
                // 等待扫码
                return { Success: true, Data: { status: 0 } };
            case 'scanned':
                // 已扫码，等待用户确认
                return { Success: true, Data: { status: 1 } };
            case 'authorized': {
                // confirm 只执行一次（OAuth code 一次性，重放已消费的 code 会失败卡死会话）
                if (!entry.confirmed) {
                    const { openid } = await wxLogin.confirm(entry.session);
                    entry.openid = openid;
                    entry.loginBuffer = entry.session.loginBuffer;
                    entry.refreshtoken = entry.session.refreshtoken || '';
                    entry.accesstoken = entry.session.accesstoken || '';
                    entry.confirmed = true;
                    // 拉取应用宝用户信息（真实昵称 + 头像 URL），失败不阻断登录
                    try {
                        const info = await wxLogin.fetchUserInfo(entry.session);
                        entry.nickname = pickUserInfoValue(info, ['nick_name']) || '';
                        entry.avatar = pickUserInfoValue(info, ['head_img_url', 'head_url', 'headimgurl', 'avatar']) || '';
                    } catch (e) {
                        logger.warn('fetch wx user info failed', { error: e.message });
                    }
                    // 头像立即持久化：同 openid 重新扫码时 getFarmCode 的兜底 gate 不会进入
                    // （账号已有凭证+头像），头像更新依赖这里，否则前端 ?v= cache-bust 不变、面板一直显示旧头像
                    if (entry.avatar) {
                        try {
                            const existing = findAccountByWxid(String(openid));
                            if (existing && typeof addOrUpdateAccount === 'function'
                                && String(existing.avatar || '') !== String(entry.avatar)) {
                                addOrUpdateAccount({ id: existing.id, avatar: entry.avatar });
                                logger.info('wx avatar updated for account', { accountId: existing.id, openid });
                            }
                        } catch (e) {
                            logger.warn('persist avatar failed', { openid, error: e.message });
                        }
                    }
                }
                return {
                    Success: true,
                    Data: {
                        acctSectResp: {
                            userName: entry.openid,
                            nickName: entry.nickname || '微信用户',
                        },
                    },
                };
            }
            case 'cancelled':
                return { Success: false, Message: '用户取消扫码' };
            case 'expired':
                wxSessions.delete(uuid);
                return { Success: false, Message: '二维码已过期，请重新获取' };
            default:
                return { Success: false, Message: `未知状态: ${status}` };
        }
    } catch (e) {
        return { Success: false, Message: `检查登录状态失败: ${e.message}` };
    }
}

/**
 * 获取 QQ 农场登录 code（Farm5 compat: openid + forceRefresh）
 * 数据源：账号持久化的 loginBuffer（扫码 confirm 时保存）→ MMTLS 换 code
 * 返回: { Success, Data: { code } }
 */
async function getFarmCode(openid) {
    if (!openid) {
        return { Success: false, Message: '缺少 openid' };
    }
    try {
        // 1. 优先用账号持久化的 loginBuffer / refreshtoken / accesstoken
        let loginBuffer = '';
        let refreshtoken = '';
        let accesstoken = '';
        let entryAvatar = '';
        const account = findAccountByWxid(openid);
        if (account && account.loginBuffer) loginBuffer = String(account.loginBuffer);
        if (account && account.refreshtoken) refreshtoken = String(account.refreshtoken);
        if (account && account.accesstoken) accesstoken = String(account.accesstoken);
        // 2. 兜底：刚扫码会话里的 loginBuffer / refreshtoken / accesstoken / 头像
        if (!loginBuffer || !refreshtoken || !account || !account.avatar) {
            for (const entry of wxSessions.values()) {
                if (entry.openid === String(openid)) {
                    if (!loginBuffer && entry.loginBuffer) loginBuffer = String(entry.loginBuffer);
                    if (!refreshtoken && entry.refreshtoken) refreshtoken = String(entry.refreshtoken);
                    if (!accesstoken && entry.accesstoken) accesstoken = String(entry.accesstoken);
                    if (entry.avatar) entryAvatar = String(entry.avatar);
                    if (loginBuffer && refreshtoken && accesstoken && entryAvatar) break;
                }
            }
        }
        if (!loginBuffer) {
            return { Success: false, Message: '缺少登录凭证（loginBuffer），请重新扫码登录' };
        }
        // 3. 换 code；loginBuffer 失效（ManualAuth rejected）时用 refreshtoken 自动续期重试
        let code;
        try {
            code = await wxLogin.issueCode({ loginBuffer }, TARGET_APP_ID);
        } catch (issueErr) {
            const msg = String(issueErr.message || '');
            if (refreshtoken && msg.includes('ManualAuth rejected')) {
                try {
                    // 传空 cookie jar（refresh 请求不依赖 OAuth 回调 cookie，Ual-Access 头鉴权）
                    const refreshed = await wxLogin.refreshLoginBuffer({ openid: String(openid), refreshtoken, accesstoken, cookies: new Map() });
                    loginBuffer = refreshed.loginBuffer;
                    refreshtoken = refreshed.refreshtoken;
                    accesstoken = refreshed.accesstoken || accesstoken;
                    code = await wxLogin.issueCode({ loginBuffer }, TARGET_APP_ID);
                } catch (refreshErr) {
                    return { Success: false, Message: `获取 Code 失败: ${humanizeWxCodeError(refreshErr.message)}（自动续期失败，请重新扫码登录）` };
                }
            } else {
                return { Success: false, Message: `获取 Code 失败: ${humanizeWxCodeError(msg)}` };
            }
        }
        if (!code) {
            return { Success: false, Message: '获取 Code 失败（服务端未返回 code）' };
        }
        // 4. 成功后将 loginBuffer / refreshtoken / accesstoken / 头像持久化到账号（供自动重登/手动启动刷新 code）
        //    注意：refreshtoken/accesstoken 是滚动续期的（每次刷新返回新值），必须总是更新，否则旧 token 过期后续期断裂
        if (account) {
            const updates = {};
            if (loginBuffer && loginBuffer !== account.loginBuffer) updates.loginBuffer = loginBuffer;
            if (refreshtoken && refreshtoken !== account.refreshtoken) updates.refreshtoken = refreshtoken;
            if (accesstoken && accesstoken !== account.accesstoken) updates.accesstoken = accesstoken;
            // 头像也总是更新（重新扫码后头像可能变化，否则前端 cache-bust 的 ?v= 不变，面板一直显示旧头像）
            if (entryAvatar && entryAvatar !== account.avatar) updates.avatar = entryAvatar;
            if (Object.keys(updates).length > 0) {
                try {
                    if (typeof addOrUpdateAccount === 'function') {
                        addOrUpdateAccount({ id: account.id, ...updates });
                    }
                } catch (e) {
                    logger.warn('persist account fields failed', { openid, error: e.message });
                }
            }
        }
        return { Success: true, Data: { code } };
    } catch (e) {
        return { Success: false, Message: `获取 Code 失败: ${humanizeWxCodeError(e.message)}` };
    }
}

/**
 * 获取账号头像（微信）
 * 1. native 方案：账号 avatar 字段（应用宝远程 URL）→ 代理下载
 * 2. fallback：yyb-go 本地头像文件（Docker 场景旧账号）
 * 返回 fetch Response（图片流），失败返回 null
 */
async function getAccountAvatar(openid) {
    if (!openid) return null;
    // 1. native 方案：账号 avatar 字段（应用宝远程 URL，仅白名单域名）
    const account = findAccountByWxid(openid);
    const storedAvatar = account && account.avatar;
    if (storedAvatar && isAllowedAvatarUrl(storedAvatar)) {
        try {
            const response = await fetch(storedAvatar, { timeout: 10000 });
            if (response.ok) return response;
        } catch (e) {
            logger.warn('native avatar download failed', { openid, error: e.message });
        }
    }
    // 2. fallback：yyb-go 本地头像（Docker 场景）
    try {
        const response = await fetch(`${YYB_BASE}/accounts/avatar?ref=${encodeURIComponent(openid)}`, {
            headers: { Authorization: `Bearer ${YYB_TOKEN}` },
            redirect: 'follow',
            timeout: 10000,
        });
        if (!response.ok) return null;
        return response;
    } catch (e) {
        logger.warn('yyb getAccountAvatar failed', { openid, error: e.message });
        return null;
    }
}

/**
 * 微信凭证主动保活：用账号 refreshtoken 刷新 loginBuffer + refreshtoken（滚动续期）
 * 关键：loginBuffer 实际有效期 > 2h，而 refreshtoken 约 2h 过期——必须主动刷新（不等 loginBuffer 失效），
 * 否则 loginBuffer 失效时 refreshtoken 已过期，续期必然失败（code=-109），只能重新扫码。
 * 每 30 分钟调用一次：refreshtoken 2h 窗口内滚动续期，永不失效。
 */
async function keepWxCredentialAlive(acc) {
    if (!acc || !acc.wxid || !acc.refreshtoken || !acc.loginBuffer) {
        return { Success: false, Message: '缺少微信凭证（refreshtoken/loginBuffer），请重新扫码登录' };
    }
    try {
        const refreshed = await wxLogin.refreshLoginBuffer({
            openid: String(acc.wxid),
            refreshtoken: String(acc.refreshtoken),
            accesstoken: String(acc.accesstoken || ''),
            cookies: new Map(),
        });
        if (typeof addOrUpdateAccount === 'function') {
            addOrUpdateAccount({
                id: acc.id,
                loginBuffer: refreshed.loginBuffer,
                refreshtoken: refreshed.refreshtoken,
                accesstoken: refreshed.accesstoken || acc.accesstoken || '',
            });
        }
        logger.info('wx credential keepalive ok', { accountId: acc.id });
        return { Success: true };
    } catch (e) {
        logger.warn('keepWxCredentialAlive failed', { accountId: acc.id, error: e.message });
        return { Success: false, Message: e.message };
    }
}

module.exports = { getQRCode, checkQR, getFarmCode, getAccountAvatar, takePendingWxInfo, keepWxCredentialAlive, YYB_BASE };
