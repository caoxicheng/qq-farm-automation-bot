import assert from 'node:assert/strict';
// eslint-disable-next-line test/no-import-node-test -- 项目测试由 Node 内置测试运行器执行
import test from 'node:test';

const { planItemUse } = require('../src/services/warehouse');

test('物品使用计划按完整 int64 UID 选择具体背包堆', () => {
    const uid = '9223372036854775806';
    const result = planItemUse([
        { id: 90001, count: 5, uid: '9223372036854775805' },
        { id: 90001, count: 3, uid },
    ], 90001, 2, uid);

    assert.deepEqual(result, [{ itemId: 90001, count: 2, uid }]);
});

test('未指定 UID 时按多个真实背包堆拆分使用数量', () => {
    const result = planItemUse([
        { id: 90001, count: 2, uid: '101' },
        { id: 90001, count: 4, uid: '102' },
    ], 90001, 5);

    assert.deepEqual(result, [
        { itemId: 90001, count: 2, uid: '101' },
        { itemId: 90001, count: 3, uid: '102' },
    ]);
});

test('物品使用计划拒绝 UID 不匹配或数量不足', () => {
    assert.throws(() => planItemUse([
        { id: 90001, count: 5, uid: '101' },
    ], 90001, 1, '102'), /物品数量不足/);
});
