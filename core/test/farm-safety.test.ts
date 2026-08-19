import assert from 'node:assert/strict';
// eslint-disable-next-line test/no-import-node-test -- 项目测试由 Node 内置测试运行器执行
import test from 'node:test';
import { getOrganicFertilizeOperationLimit } from '../src/services/farm';

test('有机肥循环按地块轮数限制请求总量', () => {
    assert.equal(getOrganicFertilizeOperationLimit(0), 0);
    assert.equal(getOrganicFertilizeOperationLimit(3), 60);
    assert.equal(getOrganicFertilizeOperationLimit(12), 240);
    assert.equal(getOrganicFertilizeOperationLimit(40), 240);
});
