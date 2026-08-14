/**
 * 推送接口封装（基于 pushoo）
 */

interface PushPayload {
    channel?: unknown;
    endpoint?: unknown;
    token?: unknown;
    title?: unknown;
    content?: unknown;
}

interface PushRequest {
    title: string;
    content: string;
    token?: string;
    options?: { webhook: { url: string; method: 'POST' } };
}

export interface PushResult {
    ok: boolean;
    code: string;
    msg: string;
    raw: Record<string, unknown>;
}

const pushoo = require('pushoo').default as (
    channel: string,
    request: PushRequest,
) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function assertRequiredText(name: string, value: unknown): string {
    const text = String(value || '').trim();
    if (!text) {
        throw new Error(`${name} 不能为空`);
    }
    return text;
}

/**
 * 发送推送
 * @param {object} payload
 * @param {string} payload.channel 必填 推送渠道（pushoo 平台名，如 webhook）
 * @param {string} [payload.endpoint] webhook 接口地址（channel=webhook 时使用）
 * @param {string} payload.token 必填 推送 token
 * @param {string} payload.title 必填 推送标题
 * @param {string} payload.content 必填 推送内容
 * @returns {Promise<{ok: boolean, code: string, msg: string, raw: any}>} 推送结果
 */
async function sendPushooMessage(payload: PushPayload = {}): Promise<PushResult> {
    const channel = assertRequiredText('channel', payload.channel);
    const endpoint = String(payload.endpoint || '').trim();
    const rawToken = String(payload.token || '').trim();
    const token = channel === 'webhook' ? rawToken : assertRequiredText('token', rawToken);
    const title = assertRequiredText('title', payload.title);
    const content = assertRequiredText('content', payload.content);

    const request: PushRequest = { title, content };
    if (token) request.token = token;
    if (channel === 'webhook') {
        request.options = {
            webhook: { url: assertRequiredText('endpoint', endpoint), method: 'POST' },
        };
    }

    const result = await pushoo(channel, request);

    const raw = result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown>
        : { data: result };
    const hasError = !!(raw && raw.error);
    const code = String(raw.code || raw.errcode || (hasError ? 'error' : 'ok'));
    const message = String(raw.msg || raw.message || (hasError ? (asRecord(raw.error).message || 'push failed') : 'ok'));
    const ok = !hasError && (code === 'ok' || code === '0' || code === '' || String(raw.status || '').toLowerCase() === 'success');

    return {
        ok,
        code,
        msg: message,
        raw,
    };
}

export {
    sendPushooMessage,
};
