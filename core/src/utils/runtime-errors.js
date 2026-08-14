const SOFT_RUNTIME_MESSAGES = new Set([
    '账号未运行',
    '账号已离线',
    'API Timeout',
]);

const SOFT_RUNTIME_PREFIXES = [
    '连接未打开:',
    '账号尚未登录',
    '请求已中断:',
];

function isSoftRuntimeError(error) {
    const message = String((error && error.message) || '');
    return SOFT_RUNTIME_MESSAGES.has(message)
        || SOFT_RUNTIME_PREFIXES.some(prefix => message.startsWith(prefix));
}

module.exports = { isSoftRuntimeError };
