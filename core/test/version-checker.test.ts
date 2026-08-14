const test = require('node:test');
const assert = require('node:assert/strict');
const {
    CHECK_INTERVAL_MS,
    compareVersions,
    createVersionChecker,
    parseVersionTag,
} = require('../src/services/version-checker');

test('解析正式版、beta 和 rc 标签', () => {
    assert.deepEqual(parseVersionTag('v20260814'), {
        tag: 'v20260814', date: 20260814, stage: 'stable', sequence: 0,
    });
    assert.equal(parseVersionTag('v20260814-beta.2').stage, 'beta');
    assert.equal(parseVersionTag('v20260814-rc.3').sequence, 3);
    assert.equal(parseVersionTag('latest'), null);
    assert.equal(parseVersionTag('v20260814-alpha.1'), null);
    assert.equal(parseVersionTag('v20261301'), null);
    assert.equal(parseVersionTag('20260814', { requirePrefix: true }), null);
});

test('版本顺序为跨日期优先，同日期 beta 小于 rc 小于正式版', () => {
    const beta = parseVersionTag('v20260814-beta.2');
    const rc = parseVersionTag('v20260814-rc.1');
    const stable = parseVersionTag('v20260814');
    const nextBeta = parseVersionTag('v20260815-beta.1');
    assert.ok(compareVersions(beta, rc) < 0);
    assert.ok(compareVersions(rc, stable) < 0);
    assert.ok(compareVersions(nextBeta, stable) > 0);
});

test('检查器选择最高有效标签并识别更新', async () => {
    const checker = createVersionChecker({
        currentVersion: '20260814',
        fetchImpl: async () => ({
            ok: true,
            json: async () => [
                { name: 'invalid' },
                { name: '20260816' },
                { name: 'v20260815-beta.1' },
                { name: 'v20260814' },
                { name: 'v20260815-rc.2' },
            ],
        }),
    });
    const status = await checker.checkNow();
    assert.equal(status.latestTag, 'v20260815-rc.2');
    assert.equal(status.updateAvailable, true);
    assert.ok(status.checkedAt > 0);
});

test('没有更高版本时不提示更新', async () => {
    const checker = createVersionChecker({
        currentVersion: '20260814',
        fetchImpl: async () => ({
            ok: true,
            json: async () => [
                { name: 'v20260814-rc.2' },
                { name: 'v20260813' },
            ],
        }),
    });
    const status = await checker.checkNow();
    assert.equal(status.latestTag, 'v20260814-rc.2');
    assert.equal(status.updateAvailable, false);
});

test('检查失败时保留上次成功状态', async () => {
    let fail = false;
    const checker = createVersionChecker({
        currentVersion: '20260814',
        fetchImpl: async () => {
            if (fail) throw new Error('network down');
            return { ok: true, json: async () => [{ name: 'v20260815' }] };
        },
    });
    const success = await checker.checkNow();
    fail = true;
    const failed = await checker.checkNow();
    assert.deepEqual(failed, success);
});

test('HTTP 请求失败时不修改初始状态', async () => {
    const checker = createVersionChecker({
        currentVersion: '20260814',
        fetchImpl: async () => ({ ok: false, status: 403 }),
    });
    const status = await checker.checkNow();
    assert.deepEqual(status, {
        currentVersion: '20260814',
        latestTag: null,
        updateAvailable: false,
        checkedAt: 0,
    });
});

test('请求超时会中止检查且不修改状态', async () => {
    const checker = createVersionChecker({
        currentVersion: '20260814',
        timeoutMs: 10,
        fetchImpl: (_url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    const status = await checker.checkNow();
    assert.equal(status.checkedAt, 0);
    assert.equal(status.updateAvailable, false);
});

test('启动时立即检查并注册每 6 小时任务', async () => {
    let requestCount = 0;
    let scheduledTask = null;
    const checker = createVersionChecker({
        currentVersion: '20260814',
        fetchImpl: async () => {
            requestCount += 1;
            return { ok: true, json: async () => [{ name: 'v20260814' }] };
        },
        scheduler: {
            setIntervalTask(name, delayMs, task, options) {
                scheduledTask = { name, delayMs, task, options };
            },
            clearAll() {},
        },
    });

    await checker.start();
    assert.equal(requestCount, 1);
    assert.equal(scheduledTask.name, 'github_version_check');
    assert.equal(scheduledTask.delayMs, CHECK_INTERVAL_MS);
    assert.equal(scheduledTask.options.preventOverlap, true);
});
export {};
