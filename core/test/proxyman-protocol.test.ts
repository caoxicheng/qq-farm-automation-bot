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

test('分享上报保留动态凭证和不透明回调结果', () => {
    // 2026-08-18 Proxyman 抓包：微信小程序分享上报及成功回包。
    const requestFixture = Buffer.from('08051203d78e06202a', 'hex');
    const replyFixture = Buffer.from('0a0408011200', 'hex');
    const request = types.ReportShareRequest.decode(requestFixture);
    const reply = types.ReportShareReply.decode(replyFixture);

    assert.equal(request.source, 5);
    assert.equal(request.scene, 42);
    assert.equal(Buffer.from(request.share_token).toString('hex'), 'd78e06');
    assert.equal(Buffer.from(reply.result).toString('hex'), '08011200');
    assert.deepEqual(Buffer.from(types.ReportShareRequest.encode(request).finish()), requestFixture);
    assert.deepEqual(Buffer.from(types.ReportShareReply.encode(reply).finish()), replyFixture);
});

test('分享上报回包兼容未领取账号返回的长凭证', () => {
    const fixture = Buffer.from(
        '0a2000112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
        'hex',
    );
    const reply = types.ReportShareReply.decode(fixture);

    assert.equal(Buffer.from(reply.result).length, 32);
    assert.equal(
        Buffer.from(reply.result).toString('hex'),
        '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    );
    assert.deepEqual(Buffer.from(types.ReportShareReply.encode(reply).finish()), fixture);
});

test('分享礼包领取回包使用字段 1 承载奖励物品', () => {
    const fixture = Buffer.from('0a0508820810020a0508f3071005', 'hex');
    const reply = types.ClaimShareRewardReply.decode(fixture);

    assert.deepEqual(reply.items.map((item: any) => item.id.toString()), ['1026', '1011']);
    assert.deepEqual(reply.items.map((item: any) => item.count.toString()), ['2', '5']);
    assert.deepEqual(Buffer.from(types.ClaimShareRewardReply.encode(reply).finish()), fixture);
});

test('分享点击按小程序使用的字符串配置和数值场景往返编码', () => {
    const fixture = Buffer.from('080012001a043132353620002a00', 'hex');
    const request = types.ReportArkClickRequest.decode(fixture);

    assert.equal(request.sharer_id.toString(), '0');
    assert.equal(request.sharer_open_id, '');
    assert.equal(request.share_cfg_id, '1256');
    assert.equal(request.scene_id.toString(), '0');
    assert.equal(Buffer.from(request.report_data).length, 0);
    assert.deepEqual(Buffer.from(types.ReportArkClickRequest.encode(request).finish()), fixture);
});

test('商城礼包购买回复保留全部奖励物品', () => {
    const fixture = Buffer.from(
        '08eb0710011a160881f1041002188092b8c398feffffff0130841c38011a160883f1041001188092b8c398feffffff0130851c3801',
        'hex',
    );
    const reply = types.PurchaseResponse.decode(fixture);

    assert.equal(reply.goods_id, 1003);
    assert.equal(reply.count, 1);
    assert.deepEqual(reply.reward_info.map((item: any) => item.id.toString()), ['80001', '80003']);
    assert.deepEqual(reply.reward_info.map((item: any) => item.count.toString()), ['2', '1']);
    assert.deepEqual(Buffer.from(types.PurchaseResponse.encode(reply).finish()), fixture);
});

test('背包物品保留服务端展示扩展字段', () => {
    const fixture = Buffer.from('0a080a0608f307a20600', 'hex');
    const reply = types.BagReply.decode(fixture);

    assert.equal(reply.item_bag.items[0].id.toString(), '1011');
    assert.equal(Buffer.from(reply.item_bag.items[0].show).length, 0);
    assert.deepEqual(Buffer.from(types.BagReply.encode(reply).finish()), fixture);
});

test('施肥回复按物品结构解析剩余化肥并保留逐地结果', () => {
    const fixture = Buffer.from('1a0608f30710d828220a08051a0608f30710d82b', 'hex');
    const reply = types.FertilizeReply.decode(fixture);

    assert.equal(reply.fertilizer.id.toString(), '1011');
    assert.equal(reply.fertilizer.count.toString(), '5208');
    assert.equal(Buffer.from(reply.results[0]).toString('hex'), '08051a0608f30710d82b');
    assert.deepEqual(Buffer.from(types.FertilizeReply.encode(reply).finish()), fixture);
});

test('游记进度保留等级与当前进度之间的服务端状态字段', () => {
    const fixture = Buffer.from('0a06520418c8fb02', 'hex');
    const reply = types.GetSeasonInfoReply.decode(fixture);

    assert.equal(reply.season_info.pass.field_3.toString(), '48584');
    assert.deepEqual(Buffer.from(types.GetSeasonInfoReply.encode(reply).finish()), fixture);
});

test('充值信息保留余额后的附加状态字段', () => {
    const requestFixture = Buffer.from('0a0131', 'hex');
    const replyFixture = Buffer.from('0a0608b90120e802', 'hex');
    const request = types.GetRechargeInfoRequest.decode(requestFixture);
    const reply = types.GetRechargeInfoReply.decode(replyFixture);

    assert.equal(request.source, '1');
    assert.equal(reply.recharge_infos[0].balance.toString(), '185');
    assert.equal(reply.recharge_infos[0].field_4.toString(), '360');
    assert.deepEqual(Buffer.from(types.GetRechargeInfoRequest.encode(request).finish()), requestFixture);
    assert.deepEqual(Buffer.from(types.GetRechargeInfoReply.encode(reply).finish()), replyFixture);
});

test('月卡查询与领取回复保留完整卡片状态', () => {
    const queryFixture = Buffer.from(
        '0a2908d10f120508ea0710781801201b28f81e30901c380140b401481e5204323030315a0608ec0710b40110919a05',
        'hex',
    );
    const claimFixture = Buffer.from(
        '0a1008ea071078188092b8c398feffffff01122708d10f120508ea071078201b28f01f30901c380140b401481e5204323030315a0608ec0710b401',
        'hex',
    );
    const query = types.GetMonthCardInfosReply.decode(queryFixture);
    const claim = types.ClaimMonthCardRewardReply.decode(claimFixture);

    assert.equal(query.infos[0].goods_id, 2001);
    assert.equal(query.infos[0].can_claim, true);
    assert.equal(query.infos[0].field_10, '2001');
    assert.equal(query.infos[0].field_11.id.toString(), '1004');
    assert.equal(claim.items[0].id.toString(), '1002');
    assert.equal(claim.info.goods_id, 2001);
    assert.deepEqual(Buffer.from(types.GetMonthCardInfosReply.encode(query).finish()), queryFixture);
    assert.deepEqual(Buffer.from(types.ClaimMonthCardRewardReply.encode(claim).finish()), claimFixture);
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
