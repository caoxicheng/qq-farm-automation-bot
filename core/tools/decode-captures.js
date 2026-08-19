/*
 * 通用抓包解码工具：对 Proxyman 抓包（proxymanlogv2）自动产出字段级协议说明。
 * 用法:
 *   node tools/decode-captures.js <proxymanlogv2 文件路径> [过滤 service 子串]
 *   node tools/decode-captures.js /path/capture.proxymanlogv2 Myste
 *   node tools/decode-captures.js /path/capture.proxymanlogv2   （全部）
 *   node tools/decode-captures.js /path/capture.proxymanlogv2 --strict
 *
 * 原理（与作者 decode-shop-protocols.js 相同，但零硬编码）:
 *   1. 每帧 gatepb.Message -> meta(service/method/message_type) + body
 *   2. message_type=1 请求 -> TSDK 解密；message_type=3 通知 -> 解 EventMessage 取内层 body
 *   3. 用 root.lookupService(service).methods[method] 自动拿到 requestType/responseType
 *   4. decode -> encode 逐字节比对（roundtrip），不一致时输出 wire_diff 定位差异字段
 * 输出: 每行一个 JSON { service, method, type, encrypted, roundtrip, wire_diff, decoded }
 */
const fs = require('node:fs');
const path = require('node:path');

function requireRuntimeModule(name) {
    const candidates = [
        path.join(__dirname, '..', 'src', 'utils', `${name}.js`),
        path.join(__dirname, '..', 'build', 'src', 'utils', `${name}.js`),
    ];
    const target = candidates.find(candidate => fs.existsSync(candidate));
    if (!target) {
        throw new Error(`缺少 ${name} 运行时模块，请先在 core/ 执行 pnpm run build:core`);
    }
    return require(target);
}

const { getRoot, loadProto } = requireRuntimeModule('proto');
const { auditProtobufMessage } = requireRuntimeModule('protobuf-audit');
const cryptoWasm = requireRuntimeModule('crypto-wasm');

let filter = process.argv[3] || '';

function toHex(buf) {
    return Buffer.from(buf).toString('hex');
}

function walk(root, serviceName, methodName, messageType) {
    let typeName = '';
    // 1) 优先 service 块（rpc 定义）
    if (serviceName && methodName) {
        try {
            const service = root.lookupService(serviceName);
            const method = service.methods[methodName];
            if (method) {
                typeName = Number(messageType) === 1 ? method.requestType : method.responseType;
            }
        } catch { /* 未定义 service 块 */ }
    }
    // 2) 按方法名约定 fallback（请求 = Method+Request，响应 = Method+Reply，带 service 包名前缀）
    if (!typeName && methodName) {
        const candidate = Number(messageType) === 1 ? `${methodName}Request` : `${methodName}Reply`;
        const pkg = serviceName.includes('.') ? serviceName.slice(0, serviceName.lastIndexOf('.')) : '';
        for (const full of [`${pkg}.${candidate}`, candidate]) {
            try {
                root.lookupType(full);
                typeName = full;
                break;
            } catch { /* try next */ }
        }
    }
    // 3) 通知类（service 名即消息类型，如 gamepb.itempb.ItemNotify）
    if (!typeName && !methodName) {
        try {
            root.lookupType(serviceName);
            typeName = serviceName;
        } catch { /* ignore */ }
    }
    if (!typeName) return null;
    return { typeName, type: root.lookupType(typeName) };
}

function print(file, service, method, typeName, type, body, encrypted, altBody) {
    let decoded;
    let roundtrip = false;
    let wire_diff;
    let compatibility_issues = [];
    // 加密请求帧：roundtrip 用解密后的 body（明文才是业务字节）
    const compareBody = altBody && altBody.length > 0 && !altBody.equals(body) ? altBody : body;
    try {
        const message = type.decode(compareBody);
        compatibility_issues = auditProtobufMessage(type, compareBody);
        decoded = type.toObject(message, { longs: String, enums: String, bytes: String });
        const encoded = Buffer.from(type.encode(message).finish());
        roundtrip = encoded.equals(Buffer.from(compareBody));
        if (!roundtrip) {
            wire_diff = { input: toHex(compareBody), encoded: toHex(encoded) };
        }
    } catch (error) {
        decoded = { decode_error: String(error.message), body_hex: toHex(compareBody) };
    }
    // 解密候选体（请求帧有的明文有的加密：同时输出解密结果供对比）
    let alt_decoded;
    if (altBody && altBody.length > 0 && !altBody.equals(body)) {
        try {
            const altMessage = type.decode(altBody);
            alt_decoded = type.toObject(altMessage, { longs: String, enums: String, bytes: String });
        } catch { /* ignore */ }
    }
    return {
        file,
        service,
        method,
        type: typeName,
        encrypted,
        compatible: roundtrip && compatibility_issues.length === 0,
        roundtrip,
        compatibility_issues,
        wire_diff,
        decoded,
        alt_decoded,
    };
}

async function processFrame(file, raw, root, results) {
    let message;
    try {
        message = root.lookupType('gatepb.Message').decode(raw);
    } catch {
        return; // ping/pong 等非 protobuf 帧
    }
    const meta = message.meta || {};
    let service = String(meta.service_name || '');
    let method = String(meta.method_name || '');
    let body = Buffer.from(message.body || []);
    let decryptedBody;
    let encrypted = false;
    const messageType = Number(meta.message_type);
    if (messageType === 1 && body.length > 0) {
        // 请求帧：明文/加密都有 —— 原样解析，同时尝试解密供对比
        try {
            decryptedBody = await cryptoWasm.decryptBuffer(body);
            encrypted = !decryptedBody.equals(body);
        } catch {
            decryptedBody = null;
        }
    } else if (messageType === 3 && body.length > 0) {
        try {
            const notification = root.lookupType('gatepb.EventMessage').decode(body);
            service = String(notification.message_type || service || '');
            method = '';
            body = Buffer.from(notification.body || []);
        } catch { /* ignore */ }
    }
    if (filter && !service.includes(filter) && !method.includes(filter)) return;
    const found = walk(root, service, method, messageType);
    if (!found) {
        if (results) {
            results.push({ file, service, method, type: null, encrypted, note: '未在 proto 中定义', body_hex: toHex(body).slice(0, 64) });
        }
        return;
    }
    const result = print(file, service, method, found.typeName, found.type, body, encrypted, decryptedBody);
    if (results) results.push(result);
    else process.stdout.write(`${JSON.stringify(result)  }\n`);
}

function fmtValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

// markdown 字段级说明：按 service.method 聚合，roundtrip 绿的出字段表，红的标差异
function renderMarkdown(results, root) {
    const groups = new Map();
    for (const r of results) {
        if (!r || !r.service) continue;
        // 请求与回复使用不同类型，必须分别统计；否则请求 roundtrip 成功会掩盖回复缺字段。
        const rpc = r.method ? `${r.service}.${r.method}` : r.service;
        const key = `${rpc} · ${r.type || 'unknown'}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    const lines = [];
    lines.push('# 抓包字段级协议说明');
    lines.push('');
    lines.push(`> 帧数: ${results.length} | 协议组: ${groups.size}`);
    lines.push('');
    let green = 0;
    let red = 0;
    for (const [key, frames] of groups) {
        const allCompatible = frames.every(frame => frame.compatible === true);
        const best = allCompatible
            ? frames.find(frame => frame.compatible) || frames[0]
            : frames.find(frame => frame.compatible !== true) || frames[0];
        const typeName = best.type;
        if (allCompatible) green++;
        else red++;
        const ok = allCompatible ? '✅' : '❌';
        lines.push(`## ${key} · \`${typeName}\` ${ok}`);
        lines.push('');
        if (!typeName) {
            lines.push(`> 未在 proto 中定义（body hex: \`${(best.body_hex || '').slice(0, 40)}\`）`);
            lines.push('');
            continue;
        }
        if (!allCompatible) {
            lines.push('> **协议审计不一致**：proto 定义与线上字节有差异（字段缺失/类型错误），需补齐 proto 后重新验证。');
            if (best.compatibility_issues?.length) {
                lines.push('');
                for (const issue of best.compatibility_issues)
                    lines.push(`- ${issue.path}: ${issue.message}`);
            }
            if (best.wire_diff) {
                lines.push('');
                lines.push('```text');
                lines.push(`input : ${best.wire_diff.input}`);
                lines.push(`encode: ${best.wire_diff.encoded}`);
                lines.push('```');
            }
            lines.push('');
            continue;
        }
        const type = root.lookupType(typeName);
        const fields = Object.values(type.fields).sort((a, b) => a.id - b.id);
        const sample = frames[0].alt_decoded && Object.keys(frames[0].alt_decoded).length ? frames[0].alt_decoded : frames[0].decoded;
        lines.push('| 字段号 | 字段名 | 类型 | 样例值 |');
        lines.push('|---|---|---|---|');
        for (const f of fields) {
            const val = sample ? fmtValue(sample[f.name]).slice(0, 80) : '';
            const typeLabel = f.repeated ? `repeated ${f.type}` : f.type;
            lines.push(`| ${f.id} | ${f.name} | ${typeLabel} | ${val} |`);
        }
        if (best.alt_decoded && Object.keys(best.alt_decoded).length && JSON.stringify(best.alt_decoded) !== JSON.stringify(best.decoded)) {
            lines.push('');
            lines.push(`> 注：请求帧为加密，此处展示解密后的字段（${frames.length} 帧）。`);
        } else if (frames.length > 1) {
            lines.push('');
            lines.push(`> 共 ${frames.length} 帧（roundtrip 一致）。`);
        }
        lines.push('');
    }
    lines.push(`---`);
    lines.push(`统计：${green} 组协议 roundtrip 一致，${red} 组存在差异。`);
    return lines.join('\n');
}

async function main() {
    const mdMode = process.argv.includes('--md');
    const strictMode = process.argv.includes('--strict');
    const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const capturePath0 = positional[0] || '';
    const filter0 = positional[1] || '';
    const capturePath = path.resolve(capturePath0);
    filter = filter0;
    if (!capturePath0 || !fs.existsSync(capturePath)) {
        console.error('用法: node tools/decode-captures.js <proxymanlogv2 文件> [过滤 service 子串] [--md] [--strict]');
        process.exitCode = 1;
        return;
    }
    await cryptoWasm.initWasm();
    await loadProto();
    const root = getRoot();
    const results = mdMode || strictMode ? [] : null;
    const emit = async (file, raw) => processFrame(file, raw, root, results);

    if (capturePath.endsWith('.proxymanlogv2')) {
        // 用系统 unzip 解出 JSON，再遍历 receipts
        const tmpDir = path.join(require('node:os').tmpdir(), `decode_cap_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        const { execFileSync } = require('node:child_process');
        execFileSync('unzip', ['-o', '-q', capturePath, '-d', tmpDir]);
        const captureFiles = fs.readdirSync(tmpDir, { withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => entry.name);
        for (const captureFile of captureFiles) {
            let data;
            try {
                data = JSON.parse(fs.readFileSync(path.join(tmpDir, captureFile), 'utf8'));
            } catch {
                continue;
            }
            const receipts = (data.websocketMessageStorage || {}).receipts || [];
            for (let i = 0; i < receipts.length; i++) {
                const payload = (receipts[i].message || {}).payload || receipts[i].payload || {};
                const b64 = Array.isArray(payload.binary) ? payload.binary.join('') : (payload.binary || payload.data || '');
                if (!b64) continue;
                let raw;
                try { raw = Buffer.from(b64, 'base64'); } catch { continue; }
                await emit(`${path.basename(captureFile)}#${i}`, raw);
            }
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } else if (fs.statSync(capturePath).isFile()) {
        // 已解压的 request_0_XX JSON（websocketMessageStorage.receipts[].message.payload.binary[] = base64 帧）
        const data = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
        const receipts = (data.websocketMessageStorage || {}).receipts || [];
        for (let i = 0; i < receipts.length; i++) {
            const payload = (receipts[i].message || {}).payload || receipts[i].payload || {};
            const b64 = Array.isArray(payload.binary) ? payload.binary.join('') : (payload.binary || payload.data || '');
            if (!b64) continue;
            let raw;
            try { raw = Buffer.from(b64, 'base64'); } catch { continue; }
            await emit(`${path.basename(capturePath)}#${i}`, raw);
        }
    } else {
        // 兼容作者的 .bin 目录（每帧一个文件）
        const names = fs.readdirSync(capturePath).filter((n) => n.endsWith('.bin')).sort();
        for (const name of names) {
            await emit(name, fs.readFileSync(path.join(capturePath, name)));
        }
    }
    if (mdMode) {
        process.stdout.write(`${renderMarkdown(results, root)  }\n`);
    } else if (strictMode) {
        for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    if (strictMode) {
        if (results.length === 0) {
            console.error('协议严格审计失败：没有找到可审计的 Protobuf 帧，请检查抓包路径、格式和过滤条件');
            process.exitCode = 1;
            return;
        }
        const failures = results.filter(result => !result.type || result.roundtrip !== true || result.compatible !== true);
        if (failures.length > 0) {
            console.error(`协议严格审计失败：${failures.length}/${results.length} 帧存在未定义类型、未知字段或 roundtrip 差异`);
            process.exitCode = 1;
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
