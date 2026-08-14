const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    readJsonFile,
    readTextFile,
    writeJsonFileAtomic,
    writeTextFileAtomic,
} = require('../src/services/json-db');

test('JSON 存储对缺失、空白和损坏内容使用独立 fallback', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'json-db-read-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'store.json');

    const missing = readJsonFile(file, () => ({ values: [] }));
    missing.values.push('changed');
    assert.deepEqual(readJsonFile(file, () => ({ values: [] })), { values: [] });

    fs.writeFileSync(file, '  ', 'utf8');
    assert.deepEqual(readJsonFile(file, () => ({ ok: true })), { ok: true });
    fs.writeFileSync(file, '{broken', 'utf8');
    assert.deepEqual(readJsonFile(file, () => ({ ok: true })), { ok: true });
});

test('原子写入创建父目录、替换完整内容且不遗留临时文件', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'json-db-write-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'nested', 'store.json');

    writeJsonFileAtomic(file, { version: 1 });
    writeJsonFileAtomic(file, { version: 2, enabled: true });

    assert.deepEqual(JSON.parse(readTextFile(file)), { version: 2, enabled: true });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['store.json']);
});

test('文本原子写入完整替换旧内容', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'json-db-text-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'share.txt');

    writeTextFileAtomic(file, 'first value');
    writeTextFileAtomic(file, 'next');

    assert.equal(readTextFile(file), 'next');
});
export {};
