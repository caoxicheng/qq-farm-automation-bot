const test = require('node:test');
const assert = require('node:assert/strict');
const Long = require('long');
const { loadProto, types } = require('../src/utils/proto');
const { ingredientsFromBag } = require('../src/services/qingmei');
const { getSellEligibility } = require('../src/services/warehouse');

test.before(async () => loadProto());

test('青梅酿造请求按背包 UID 传递多组原料', () => {
    const encoded = types.StartQingMeiBrewRequest.encode(types.StartQingMeiBrewRequest.create({
        activity_id: Long.fromString('2026081202'),
        operate_type: 14,
        params: { ingredients: [{ uid: Long.fromString('9001'), count: 2 }, { uid: Long.fromString('9002'), count: 3 }] },
    })).finish();
    const decoded = types.StartQingMeiBrewRequest.decode(encoded);
    assert.equal(decoded.params.ingredients.length, 2);
    assert.equal(decoded.params.ingredients[0].uid.toString(), '9001');
    assert.equal(decoded.params.ingredients[1].count.toString(), '3');
});

test('背包青梅原料保留 UID 并排除无 UID 系统项', () => {
    const result = ingredientsFromBag({ item_bag: { items: [
        { id: 41221, uid: 101, count: 4, mutant_types: [7] },
        { id: 41221, uid: 0, count: 9 },
        { id: 40002, uid: 102, count: 3 },
    ] } });
    assert.deepEqual(result.map(item => ({ uid: item.uid, count: item.count, mutantTypes: item.mutantTypes })), [
        { uid: '101', count: '4', mutantTypes: ['7'] },
    ]);
});

test('新版物品使用与活动分享协议保留数量和场景参数', () => {
    const use = types.UseRequest.decode(types.UseRequest.encode(types.UseRequest.create({ item: { id: 100003, count: 5 } })).finish());
    assert.equal(use.item.id.toString(), '100003');
    assert.equal(use.item.count.toString(), '5');
    const share = types.ReportShareRequest.decode(types.ReportShareRequest.encode(types.ReportShareRequest.create({ source: 11, scene: 215 })).finish());
    assert.equal(share.source, 11);
    assert.equal(share.scene, 215);
});

test('活动青梅不可直接出售，普通果实仍可出售', () => {
    assert.deepEqual(getSellEligibility(41221), { sellable: false, status: 'conditional', price: 0 });
    assert.deepEqual(getSellEligibility(40002), { sellable: true, status: 'available', price: 2 });
});

test('展示目录中的价格不能授权出售业务配置缺失的物品', () => {
    assert.deepEqual(getSellEligibility(40069), { sellable: false, status: 'conditional', price: 0 });
});
