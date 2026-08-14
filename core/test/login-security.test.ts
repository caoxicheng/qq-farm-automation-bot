const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLoginSecurityService } = require('../src/models/login-security');
const { readJsonFile, writeJsonFileAtomic } = require('../src/services/json-db');

function createService(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-login-security-'));
    let currentTime = 1_700_000_000_000;
    const service = createLoginSecurityService({
        ensureDataDir: () => root,
        getDataFile: name => path.join(root, name),
        readJsonFile,
        writeJsonFileAtomic,
        now: () => currentTime,
        random: () => 0.5,
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return {
        root,
        service,
        advance: milliseconds => { currentTime += milliseconds; },
    };
}

test('同一 IP 每分钟第十一次登录请求会被限流并在窗口后恢复', (t) => {
    const { service, advance } = createService(t);
    service.loadLoginAttempts();
    for (let index = 0; index < 10; index += 1) {
        assert.equal(service.checkRateLimit('127.0.0.1').allowed, true);
    }
    const limited = service.checkRateLimit('127.0.0.1');
    assert.equal(limited.allowed, false);
    assert.equal(limited.remainingMs, 60_000);

    advance(60_001);
    assert.equal(service.checkRateLimit('127.0.0.1').allowed, true);
});

test('连续五次失败会锁定账号，锁定期结束后自动清理', (t) => {
    const { service, advance } = createService(t);
    service.loadLoginAttempts();
    for (let index = 0; index < 4; index += 1) {
        assert.equal(service.recordFailedAttempt('alice').locked, false);
    }
    assert.equal(service.recordFailedAttempt('alice').locked, true);
    assert.equal(service.checkAccountLockout('alice').locked, true);

    advance(15 * 60 * 1000 + 1);
    assert.deepEqual(service.checkAccountLockout('alice'), { locked: false });
});

test('登录日志按时间倒序读取并使用原子 JSON 持久化', (t) => {
    const { root, service, advance } = createService(t);
    service.addLoginLog({ event: 'first' });
    advance(1000);
    service.addLoginLog({ event: 'second' });
    const result = service.getLoginLogs(1, 0);
    assert.equal(result.total, 2);
    assert.equal(result.logs[0].event, 'second');
    assert.equal(fs.existsSync(path.join(root, 'login-logs.json')), true);
    assert.deepEqual(service.clearLoginLogs(), { ok: true });
    assert.equal(service.getLoginLogs().total, 0);
});
export {};
