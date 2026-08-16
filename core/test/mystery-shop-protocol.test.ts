const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeMysteryShopOffer } = require('../src/services/mystery-shop');
const { loadProto, types } = require('../src/utils/proto');

test.before(async () => loadProto());

test('神秘商人推送按抓包字段解析商品数量、折扣和到期时间', () => {
    // 2026-08-16 Proxyman 抓包 frame 248：艾草种子 x8，5 折，总价 40000 金币。
    const fixture = Buffer.from(
        '0a1608ef07108fa5011802200828e907308827383248904e10bf8e8bd406',
        'hex',
    );
    const notify = types.MysteryShopNotify.decode(fixture);

    assert.equal(notify.npc.npc_id.toString(), '1007');
    assert.equal(notify.npc.reward_item_id.toString(), '21135');
    assert.equal(notify.npc.field_3, 2);
    assert.equal(notify.npc.reward_count, 8);
    assert.equal(notify.npc.currency_item_id.toString(), '1001');
    assert.equal(notify.npc.unit_price.toString(), '5000');
    assert.equal(notify.npc.discount_percent, 50);
    assert.equal(notify.npc.purchased_count, 0);
    assert.equal(notify.npc.original_unit_price.toString(), '10000');
    assert.equal(notify.expire_time.toString(), '1786955583');
    assert.deepEqual(Buffer.from(types.MysteryShopNotify.encode(notify).finish()), fixture);

    const offer = normalizeMysteryShopOffer(notify);
    assert.ok(offer);
    assert.equal(offer.key, '1007:1786955583');
    assert.deepEqual(offer.reward, {
        id: '21135',
        count: '8',
        name: '艾草种子',
        image: offer.reward.image,
    });
    assert.equal(offer.currency.name, '金币');
    assert.equal(offer.currency.unitPrice, '5000');
    assert.equal(offer.currency.totalPrice, '40000');
    assert.equal(offer.currency.originalTotalPrice, '80000');
    assert.equal(offer.discountPercent, 50);
});

test('神秘商品购买请求只发送 npc_id，不携带旧版猜测的购买数量', () => {
    // frame 482 的解密请求体；服务端出售的是整份商品，客户端不传 count。
    const fixture = Buffer.from('08ef07', 'hex');
    const request = types.BuyRequest.decode(fixture);

    assert.equal(request.npc_id.toString(), '1007');
    assert.deepEqual(Object.keys(types.BuyRequest.fields), ['npc_id']);
    assert.deepEqual(Buffer.from(types.BuyRequest.encode(request).finish()), fixture);
});

test('登录补查协议保留历史活动包装字段，与新版推送包装分别解码', () => {
    assert.equal(types.GetActiveNPCReply.fields.is_active.id, 1);
    assert.equal(types.GetActiveNPCReply.fields.npc.id, 2);
    assert.equal(types.GetActiveNPCReply.fields.active_time.id, 3);
    assert.equal(types.GetActiveNPCReply.fields.expire_time.id, 4);
    assert.equal(types.MysteryShopNotify.fields.npc.id, 1);
    assert.equal(types.MysteryShopNotify.fields.expire_time.id, 2);
});

test('神秘商品购买回复保留完整奖励与商品快照', () => {
    // frame 483 的解密回复体，奖励为艾草种子 x8。
    const fixture = Buffer.from(
        '0a16088fa5011008188092b8c398feffffff01309c193801121808ef07108fa5011802200828e9073088273832400148904e',
        'hex',
    );
    const reply = types.BuyReply.decode(fixture);

    assert.equal(reply.rewards[0].id.toString(), '21135');
    assert.equal(reply.rewards[0].count.toString(), '8');
    assert.equal(reply.npc.npc_id.toString(), '1007');
    assert.equal(reply.npc.reward_count, 8);
    assert.equal(reply.npc.purchased_count, 1);
    assert.equal(normalizeMysteryShopOffer({ npc: reply.npc, expire_time: '1786955583' }), null);
    assert.deepEqual(Buffer.from(types.BuyReply.encode(reply).finish()), fixture);
});

export {};
