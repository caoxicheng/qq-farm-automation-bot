const test = require('node:test');
const assert = require('node:assert/strict');
const Long = require('long');
const { loadProto, types } = require('../src/utils/proto');
const { ingredientsFromBag, buildQuoteHistory } = require('../src/services/qingmei');
const { getSellEligibility, isAutoSellEligible } = require('../src/services/warehouse');

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

test('青酿历史报价按总金币反推单价，不直接错配协议价格数组', () => {
    buildQuoteHistory({ current_round: 0, quote_totals: [] });
    const quotes = buildQuoteHistory({
        base_gold: 9202320,
        base_price: 10000,
        current_round: 3,
        quote_prices: [30000, 10000, 20000],
        quote_totals: [9202320, 9202320, 18404640],
    });
    assert.deepEqual(quotes, [
        { round: 1, unitPrice: '10000', totalGold: '9202320', doubled: false },
        { round: 2, unitPrice: '10000', totalGold: '9202320', doubled: false },
        { round: 3, unitPrice: '20000', totalGold: '18404640', doubled: false },
    ]);
});

test('青酿操作回包中的精确报价优先于快照推导结果', () => {
    buildQuoteHistory({ current_round: 0, quote_totals: [] });
    const quotes = buildQuoteHistory({
        base_gold: 9202320,
        base_price: 10000,
        current_round: 1,
        quote_prices: [30000],
        quote_totals: [9202320],
    }, { round: 1, unit_price: 10000, total_gold: 9202320, doubled: true });
    assert.deepEqual(quotes, [
        { round: 1, unitPrice: '10000', totalGold: '9202320', doubled: true },
    ]);
});

test('新版物品使用与活动分享协议保留数量和场景参数', () => {
    const use = types.UseRequest.decode(types.UseRequest.encode(types.UseRequest.create({ item: { id: 100003, count: 5, uid: '9223372036854775806' } })).finish());
    assert.equal(use.item.id.toString(), '100003');
    assert.equal(use.item.count.toString(), '5');
    assert.equal(use.item.uid.toString(), '9223372036854775806');
    const share = types.ReportShareRequest.decode(types.ReportShareRequest.encode(types.ReportShareRequest.create({ source: 11, scene: 215 })).finish());
    assert.equal(share.source, 11);
    assert.equal(share.scene, 215);
});

test('活动青梅不可直接出售，普通果实仍可出售', () => {
    const activityFruit = getSellEligibility(41221);
    assert.equal(activityFruit.sellable, false);
    assert.equal(activityFruit.status, 'conditional');
    assert.deepEqual(activityFruit.rewards, []);

    const regularFruit = getSellEligibility(40002);
    assert.equal(regularFruit.sellable, true);
    assert.equal(regularFruit.status, 'available');
    assert.equal(regularFruit.itemType, 6);
    assert.deepEqual(regularFruit.rewards, [{ id: 1001, amount: 2, unit: '金币' }]);
});

test('展示目录中的价格不能授权出售业务配置缺失的物品', () => {
    const eligibility = getSellEligibility(20002);
    assert.equal(eligibility.sellable, false);
    assert.equal(eligibility.status, 'unavailable');
    assert.deepEqual(eligibility.rewards, []);
});

test('黄金果实只允许手动出售，不进入自动卖果实', () => {
    const regularFruit = getSellEligibility(49003);
    assert.equal(regularFruit.sellable, true);
    assert.equal(isAutoSellEligible(regularFruit), true);

    const superFruit = getSellEligibility(1049003);
    assert.equal(superFruit.sellable, true);
    assert.equal(superFruit.itemType, 17);
    assert.deepEqual(superFruit.rewards, [{ id: 1005, amount: 30, unit: '金豆豆' }]);
    assert.equal(isAutoSellEligible(superFruit), false);

    assert.equal(isAutoSellEligible({ sellable: true, itemType: 6, rewards: [{ id: 1002, amount: 5 }] }), false);
});
export {};
