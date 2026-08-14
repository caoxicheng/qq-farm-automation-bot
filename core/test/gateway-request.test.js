const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProto, types } = require('../src/utils/proto');
const {
    generateGatewayRequestToken,
    encodeGatewayRequest,
} = require('../src/utils/gateway-request');

const TOKEN_PATTERN = /^[a-z0-9]{64,127}=$/i;

test.before(async () => loadProto());

test('网关请求 token 符合字符集、长度和结尾格式', () => {
    for (let index = 0; index < 256; index += 1) {
        const token = generateGatewayRequestToken();
        assert.match(token, TOKEN_PATTERN);
        assert.ok(token.length >= 65 && token.length <= 128);
    }
});

test('每个网关请求生成独立随机 token', () => {
    const tokens = new Set(Array.from({ length: 256 }, generateGatewayRequestToken));
    assert.equal(tokens.size, 256);
});

test('网关封包使用字段 3 携带请求 token', () => {
    assert.equal(types.GateMessage.fields.token.id, 3);
    assert.equal(types.GateMessage.fields.token.type, 'string');

    const body = Buffer.from([1, 2, 3, 4]);
    const first = types.GateMessage.decode(encodeGatewayRequest(
        'gamepb.userpb.UserService',
        'Heartbeat',
        body,
        17,
        23,
    ));
    const second = types.GateMessage.decode(encodeGatewayRequest(
        'gamepb.userpb.UserService',
        'Heartbeat',
        body,
        18,
        23,
    ));

    assert.equal(first.meta.service_name, 'gamepb.userpb.UserService');
    assert.equal(first.meta.method_name, 'Heartbeat');
    assert.equal(first.meta.message_type, 1);
    assert.equal(first.meta.client_seq.toString(), '17');
    assert.equal(first.meta.server_seq.toString(), '23');
    assert.deepEqual(Buffer.from(first.body), body);
    assert.match(first.token, TOKEN_PATTERN);
    assert.match(second.token, TOKEN_PATTERN);
    assert.notEqual(first.token, second.token);
});
