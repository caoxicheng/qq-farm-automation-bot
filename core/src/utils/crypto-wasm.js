const fs = require('fs');
const path = require('path');

let memory = null;
let encryptRaw = null;
let decryptRaw = null;
let generateTokenRaw = null;
let createBufRaw = null;
let destroyBufRaw = null;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let initPromise = null;

function initWasm() {
    if (initPromise) return initPromise;

    initPromise = new Promise((resolve, reject) => {
        try {
            const wasmPath = path.join(__dirname, 'tsdk.wasm');
            const wasmBuffer = fs.readFileSync(wasmPath);
            const importObject = {
                a: {
                    a: () => { }, b: () => { }, c: () => { }, d: () => { }, e: () => { },
                    f: () => { }, g: () => { }, h: () => { }, i: () => { }, j: () => { },
                    k: () => { }, l: () => { }, m: () => { }, n: () => { }, o: () => { },
                    p: () => { }, q: () => { }, r: () => { }, s: () => { }, t: () => { },
                    u: () => { }
                }
            };

            WebAssembly.instantiate(wasmBuffer, importObject).then(({ instance }) => {
                const exports = instance.exports;
                try { exports.E(); } catch { }
                memory = exports.v;
                generateTokenRaw = exports._;
                encryptRaw = exports.J;
                decryptRaw = exports.K;
                createBufRaw = exports.z;
                destroyBufRaw = exports.A;
                resolve();
            }).catch(reject);
        } catch (e) {
            reject(e);
        }
    });
    return initPromise;
}

async function generateToken(str) {
    if (!memory) await initWasm();

    const data = encoder.encode(str);
    const ptr = createBufRaw ? createBufRaw(data.length + 1) : 1024;
    const memView = new Uint8Array(memory.buffer);
    memView.set(data, ptr);
    memView[ptr + data.length] = 0;

    const resPtr = generateTokenRaw(ptr, data.length);
    let end = resPtr;
    while (memView[end] !== 0 && end - resPtr < 1000) end++;

    const outputBytes = memView.slice(resPtr, end);
    if (createBufRaw) destroyBufRaw(ptr);
    return decoder.decode(outputBytes);
}

async function encryptBuffer(buffer) {
    if (!memory) await initWasm();

    const ptr = createBufRaw(buffer.length);
    const memView = new Uint8Array(memory.buffer);
    memView.set(buffer, ptr);

    encryptRaw(ptr, buffer.length);

    const output = Buffer.from(memory.buffer, ptr, buffer.length);
    const result = Buffer.from(output);
    destroyBufRaw(ptr);
    return result;
}

async function decryptBuffer(buffer) {
    if (!memory) await initWasm();

    const ptr = createBufRaw(buffer.length);
    const memView = new Uint8Array(memory.buffer);
    memView.set(buffer, ptr);

    decryptRaw(ptr, buffer.length);

    const output = Buffer.from(memory.buffer, ptr, buffer.length);
    const result = Buffer.from(output);
    destroyBufRaw(ptr);
    return result;
}

module.exports = {
    initWasm,
    generateToken,
    encryptBuffer,
    decryptBuffer,
    encryptData: generateToken
};
