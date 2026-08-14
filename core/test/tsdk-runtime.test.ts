const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TsdkRuntime } = require('../src/utils/tsdk-runtime');

test('TSDK WASM 可初始化并完成加解密往返', async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-tsdk-test-'));
    const runtime = new TsdkRuntime();
    runtime.dataDir = dataDir;
    t.after(() => {
        runtime.destroy();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    await runtime.init();
    const source = Buffer.from('tsdk-roundtrip-fixture');
    const encrypted = runtime.transform(source, false);
    assert.notDeepEqual(encrypted, source);
    assert.deepEqual(runtime.transform(encrypted, true), source);
});

test('TSDK 文件访问拒绝越出账号数据目录', (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-tsdk-path-test-'));
    const runtime = new TsdkRuntime();
    runtime.dataDir = dataDir;
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    assert.equal(runtime.resolveDataPath('cache/state.json'), path.join(dataDir, 'cache', 'state.json'));
    assert.throws(() => runtime.resolveDataPath('../outside.json'), /越出账号目录/);
});
export {};
