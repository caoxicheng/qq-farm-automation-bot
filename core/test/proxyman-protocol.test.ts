const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProto, types } = require('../src/utils/proto');

test.before(async () => loadProto());

test('Farming 请求兼容抓包中的批量土地、好友 GID 和固定字段', () => {
    // 2026-08-16 Proxyman 抓包中 seq=70 的请求体（经 TSDK 解密）。
    const fixture = Buffer.from('0a04050a0d16109a9db4d10418002002', 'hex');
    const decoded = types.FarmingRequest.decode(fixture);

    assert.deepEqual(decoded.land_ids.map((id: any) => id.toString()), ['5', '10', '13', '22']);
    assert.equal(decoded.host_gid.toString(), '1244466842');
    assert.equal(decoded.is_all, false);
    assert.equal(decoded.field_4, 2);
    assert.deepEqual(Buffer.from(types.FarmingRequest.encode(decoded).finish()), fixture);
});

test('Farming 回复保留同一土地的多次帮忙操作结果', () => {
    // 截取自同一抓包 FarmingReply 的 field 3；每项仅包含已确认的 land_id。
    const fixture = Buffer.from('1a02080a1a0208161a0208051a02080d', 'hex');
    const decoded = types.FarmingReply.decode(fixture);

    assert.deepEqual(decoded.operation_results.map((item: any) => item.land_id.toString()), ['10', '22', '5', '13']);
    assert.deepEqual(Buffer.from(types.FarmingReply.encode(decoded).finish()), fixture);
});

test('CannelNew 保持服务端拼写并按物品 ID 往返编码', () => {
    // 每日登录礼包领取后，小程序用该 RPC 清除 80001 的“新物品”标记。
    const fixture = Buffer.from('0881f104', 'hex');
    const request = types.CannelNewRequest.decode(fixture);
    const reply = types.CannelNewReply.decode(fixture);

    assert.equal(request.item_id.toString(), '80001');
    assert.equal(reply.item_id.toString(), '80001');
    assert.deepEqual(Buffer.from(types.CannelNewRequest.encode(request).finish()), fixture);
    assert.deepEqual(Buffer.from(types.CannelNewReply.encode(reply).finish()), fixture);
});

test('邮件列表保留发送时间和领取前后的过期时间', () => {
    const beforeClaim = Buffer.from(
        'CuEBCpQBbWM1X0NCZ0FBb1hiNi1oeGdzRXUzOEMxT3l6bVIwel9zYmxFQlFjWWcwZUFjMEgzLUJSSGVwbC1CVzVLN1RzN0F1UnRQTGprNGlLYzY1YnpWSzlnX3NzX2l0ZW1fbWFpbF8xMjM3NDg2OTA0XzE3ODY4NjkwOTRfd3hfZ2lmdF8xX+avj+aXpeeZu+W9leekvOWMhRABGhvmuLjmiI/lnIjmr4/ml6XnmbvlvZXnpLzljIUoATDm6oXUBjob5ri45oiP5ZyI5q+P5pel55m75b2V56S85YyFQOaEpNUG',
        'base64',
    );
    const afterClaim = Buffer.from(
        'CuMBCpQBbWM1X0NCZ0FBb1hiNi1oeGdzRXUzOEMxT3l6bVIwel9zYmxFQlFjWWcwZUFjMEgzLUJSSGVwbC1CVzVLN1RzN0F1UnRQTGprNGlLYzY1YnpWSzlnX3NzX2l0ZW1fbWFpbF8xMjM3NDg2OTA0XzE3ODY4NjkwOTRfd3hfZ2lmdF8xX+avj+aXpeeZu+W9leekvOWMhRABGhvmuLjmiI/lnIjmr4/ml6XnmbvlvZXnpLzljIUgASgBMObqhdQGOhvmuLjmiI/lnIjmr4/ml6XnmbvlvZXnpLzljIVA7I2L1AY=',
        'base64',
    );
    const beforeReply = types.GetEmailListReply.decode(beforeClaim);
    const afterReply = types.GetEmailListReply.decode(afterClaim);
    const before = beforeReply.emails[0];
    const after = afterReply.emails[0];

    assert.equal(before.send_time.toString(), '1786869094');
    assert.equal(before.expire_time.toString(), '1789461094');
    assert.equal(before.claimed, false);
    assert.equal(after.send_time.toString(), '1786869094');
    assert.equal(after.expire_time.toString(), '1786955500');
    assert.equal(after.claimed, true);
    assert.deepEqual(Buffer.from(types.GetEmailListReply.encode(beforeReply).finish()), beforeClaim);
    assert.deepEqual(Buffer.from(types.GetEmailListReply.encode(afterReply).finish()), afterClaim);
});

test('青梅误点直接卖出使用结算模式 1 并返回对应金币', () => {
    const requestFixture = Buffer.from('08b2978ec60710109207020801', 'hex');
    const replyFixture = Buffer.from('9a071c080110c0f7920b1a1308e90710c0f7920b188092b8c398feffffff01', 'hex');
    const request = types.SettleQingMeiBrewRequest.decode(requestFixture);
    const reply = types.ActivityOperateReply.decode(replyFixture);

    assert.equal(request.activity_id.toString(), '2026081202');
    assert.equal(request.operate_type.toString(), '16');
    assert.equal(request.params.settlement_mode.toString(), '1');
    assert.equal(reply.qingmei_settlement.settlement_mode.toString(), '1');
    assert.equal(reply.qingmei_settlement.total_gold.toString(), '23378880');
    assert.equal(reply.qingmei_settlement.reward.id.toString(), '1001');
    assert.equal(reply.qingmei_settlement.reward.count.toString(), '23378880');
    assert.deepEqual(Buffer.from(types.SettleQingMeiBrewRequest.encode(request).finish()), requestFixture);
    assert.deepEqual(Buffer.from(types.ActivityOperateReply.encode(reply).finish()), replyFixture);
});

export {};
