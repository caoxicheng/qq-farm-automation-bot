const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
    generateCardCode,
    hashPassword,
    needsRehash,
    validatePasswordStrength,
    verifyPassword,
} = require('../src/models/user-password');

test('PBKDF2 密码哈希可验证且错误密码安全失败', () => {
    const stored = hashPassword('Strong123!', 'fixed-salt');
    assert.equal(stored.startsWith('fixed-salt:'), true);
    assert.equal(verifyPassword('Strong123!', stored), true);
    assert.equal(verifyPassword('Wrong123!', stored), false);
    assert.equal(needsRehash(stored), false);
});

test('旧 SHA-256 密码仍可验证并标记为需要升级', () => {
    const stored = crypto.createHash('sha256').update('Legacy123').digest('hex');
    assert.equal(verifyPassword('Legacy123', stored), true);
    assert.equal(verifyPassword('Wrong123', stored), false);
    assert.equal(needsRehash(stored), true);
});

test('密码强度和卡密格式在边界值保持稳定', () => {
    assert.equal(validatePasswordStrength('123456').valid, false);
    assert.equal(validatePasswordStrength('Strong123').valid, true);
    const card = generateCardCode(() => 0.5);
    assert.match(card, /^[A-Z0-9]{16}$/);
});
export {};
