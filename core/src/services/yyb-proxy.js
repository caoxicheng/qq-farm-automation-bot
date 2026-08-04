const process = require('node:process');
/**
 * YYB-Go 应用宝协议服务适配层
 * 将 qq-farm 面板期望的 vxcode 风格接口映射到 yyb-go 服务
 * yyb-go: https://github.com/Aoluis1005/yyb-go (Farm5 compat)
 */

const fetch = require('node-fetch');
const { createModuleLogger } = require('./logger');

const logger = createModuleLogger('yyb-proxy');

// 容器内通过 compose 网络访问 yyb-go 服务，可用环境变量覆盖
const YYB_BASE = process.env.YYB_GO_BASE || 'http://yyb-go:8000';
const YYB_TOKEN = process.env.YYB_API_TOKEN || 'yyb-go-local-token';

async function yybRequest(path, { method = 'GET', body } = {}) {
    const url = `${YYB_BASE}${path}`;
    logger.info('yyb request', { method, url });
    const response = await fetch(url, {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            Authorization: `Bearer ${YYB_TOKEN}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        timeout: 60000,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`yyb-go HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return response.json();
}

// yyb-go 统一返回 { code, msg, data }，解包取 data
function unwrap(response) {
    if (!response || typeof response !== 'object') return null;
    return response.data || null;
}

/**
 * 获取微信登录二维码
 * 返回: { Success, Data: { Uuid, QrBase64 } }
 */
async function getQRCode() {
    let raw;
    try {
        raw = await yybRequest('/qr?as_base64=true', { method: 'POST' });
    } catch (e) {
        return { Success: false, Message: `获取二维码失败: ${e.message}` };
    }
    const data = unwrap(raw);
    if (!data || !data.session_id) {
        return { Success: false, Message: raw.msg || '获取二维码失败' };
    }
    return {
        Success: true,
        Data: {
            Uuid: data.session_id,
            QrBase64: data.image_base64 || '',
        },
    };
}

/**
 * 轮询扫码状态
 * 返回: { Success, Data: { status } } 或 { Success, Data: { acctSectResp } }
 */
async function checkQR(uuid) {
    if (!uuid) {
        return { Success: false, Message: '缺少 uuid' };
    }
    let raw;
    try {
        raw = await yybRequest(`/qr/${encodeURIComponent(uuid)}/poll`);
    } catch (e) {
        return { Success: false, Message: `轮询失败: ${e.message}` };
    }

    const data = unwrap(raw) || {};
    const status = data.status || 'unknown';
    switch (status) {
        case 'pending':
            // 等待扫码
            return { Success: true, Data: { status: 0 } };
        case 'scanned':
            // 已扫码，等待用户确认
            return { Success: true, Data: { status: 1 } };
        case 'authorized':
        case 'confirmed': {
            // 已授权/已确认：调 confirm 拿账号信息
            try {
                const confirmRaw = await yybRequest(`/qr/${encodeURIComponent(uuid)}/confirm`, { method: 'POST' });
                const account = unwrap(confirmRaw) || {};
                const openid = account.openid || '';
                if (!openid) {
                    return { Success: false, Message: '确认登录失败：未获取到 openid' };
                }
                return {
                    Success: true,
                    Data: {
                        acctSectResp: {
                            userName: openid,
                            nickName: account.nickname || '微信用户',
                        },
                    },
                };
            } catch (e) {
                return { Success: false, Message: `确认登录失败: ${e.message}` };
            }
        }
        case 'cancelled':
            return { Success: false, Message: '用户取消扫码' };
        case 'expired':
            return { Success: false, Message: '二维码已过期，请重新获取' };
        default:
            return { Success: false, Message: data.message || `未知状态: ${status}` };
    }
}

/**
 * 获取 QQ 农场登录 code（Farm5 compat: openid + forceRefresh）
 * 返回: { Success, Data: { code } }
 */
async function getFarmCode(openid) {
    if (!openid) {
        return { Success: false, Message: '缺少 openid' };
    }
    try {
        const raw = await yybRequest('/wxapp/getCode', {
            method: 'POST',
            body: { openid, forceRefresh: true },
        });
        const data = unwrap(raw) || {};
        if (data.code) {
            return { Success: true, Data: { code: data.code } };
        }
        return { Success: false, Message: data.error || raw.msg || '获取 Code 失败' };
    } catch (e) {
        return { Success: false, Message: `获取 Code 失败: ${e.message}` };
    }
}

/**
 * 获取账号头像（微信，yyb-go 本地头像文件）
 * 返回 fetch Response（图片流），失败返回 null
 */
async function getAccountAvatar(openid) {
    if (!openid) return null;
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

module.exports = { getQRCode, checkQR, getFarmCode, getAccountAvatar, YYB_BASE };
