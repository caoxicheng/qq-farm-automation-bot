const test = require('node:test');
const assert = require('node:assert/strict');
const { isSoftRuntimeError } = require('../src/utils/runtime-errors');

test('账号启动和重连期间的网关状态不映射为服务器错误', () => {
    assert.equal(isSoftRuntimeError(new Error('连接未打开: Bag')), true);
    assert.equal(isSoftRuntimeError(new Error('账号尚未登录')), true);
    assert.equal(isSoftRuntimeError(new Error('请求已中断: 主动重连')), true);
});

test('已有的离线和 Worker 超时状态继续按软错误处理', () => {
    assert.equal(isSoftRuntimeError(new Error('账号未运行')), true);
    assert.equal(isSoftRuntimeError(new Error('账号已离线')), true);
    assert.equal(isSoftRuntimeError(new Error('API Timeout')), true);
});

test('真实服务端异常仍保留 HTTP 500 处理路径', () => {
    assert.equal(isSoftRuntimeError(new Error('数据库损坏')), false);
    assert.equal(isSoftRuntimeError(new Error('GatewayError: code=500')), false);
});
