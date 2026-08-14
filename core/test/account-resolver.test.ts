const assert = require('node:assert/strict');
const test = require('node:test');
const {
    findAccountByRef,
    normalizeAccountRef,
    resolveAccountId,
} = require('../src/services/account-resolver');

const accounts = [
    { id: '1', uin: '10001', qq: '20001', name: '账号一' },
    { id: '2', uin: 10002, qq: 20002, name: '账号二' },
];

test('账号引用统一裁剪字符串并兼容数组参数', () => {
    assert.equal(normalizeAccountRef(' 10001 '), '10001');
    assert.equal(normalizeAccountRef([' 2 ', 'ignored']), '2');
    assert.equal(normalizeAccountRef(null), '');
});

test('账号可通过 id、uin 或 qq 精确解析为内部 id', () => {
    assert.equal(resolveAccountId(accounts, '1'), '1');
    assert.equal(resolveAccountId(accounts, '10002'), '2');
    assert.equal(resolveAccountId(accounts, 20001), '1');
    assert.equal(findAccountByRef(accounts, '20002').name, '账号二');
});

test('空引用、未知引用和无效账号不会误匹配', () => {
    assert.equal(findAccountByRef(accounts, ''), null);
    assert.equal(findAccountByRef([null, 'invalid'], '1'), null);
    assert.equal(resolveAccountId(accounts, '01'), '');
    assert.equal(resolveAccountId(accounts, 'missing'), '');
});
export {};
