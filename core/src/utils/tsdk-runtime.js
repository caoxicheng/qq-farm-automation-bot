const __defProp = Object.defineProperty;
const __getOwnPropDesc = Object.getOwnPropertyDescriptor;
const __getOwnPropNames = Object.getOwnPropertyNames;
const __hasOwnProp = Object.prototype.hasOwnProperty;
const __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (const key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
const __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
const tsdk_runtime_exports = {};
module.exports = __toCommonJS(tsdk_runtime_exports);
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { CONFIG } = require("../config/config");
const { ensureDataDir, getResourcePath } = require("../config/runtime-paths");
const { log, logWarn } = require("./utils");
const TSDK_VERSION = "v3.8.6.1785239995";
const TSDK_SHA256 = "14754428297ee0d5aa6cceee76e6ef076bdac31ceda0ea2e2bf4a0472c8e717f";
const MINI_PROGRAM_APP_ID = "wx5306c5978fdb76e4";
const TSDK_GAME_ID = 3167;
const TSDK_APP_KEY = "0";
const RUNTIME_TABLE = Buffer.from([
  93,
  86,
  110,
  34,
  65,
  129,
  8,
  113,
  53,
  192,
  121,
  32,
  86,
  162,
  255,
  139,
  217,
  70,
  223,
  0,
  45,
  176,
  85,
  103,
  234,
  116,
  120,
  194,
  206,
  7,
  176,
  222,
  56,
  6,
  161,
  159,
  154,
  231,
  93,
  229,
  39,
  107,
  197,
  136,
  167,
  52,
  155,
  228,
  209,
  117,
  218,
  8,
  107,
  241,
  32,
  62,
  53,
  200,
  238
]);
const MERGED_DATA_KEY = 1871261153;
const MERGED_DATA_SEGMENTS = [
  [1024, 5541],
  [6580, 8989],
  [15585, 33],
  [15643, 1],
  [15655, 21],
  [15701, 1],
  [15713, 21],
  [15759, 1],
  [15771, 30],
  [15826, 14],
  [15875, 1],
  [15887, 21],
  [15933, 1],
  [15945, 671],
  [16632, 400],
  [17040, 103],
  [67371008, 404]
];
class TsdkRuntime {
  accountId;
  dataDir;
  memory = null;
  exports = null;
  initPromise = null;
  ready = false;
  destroyed = false;
  userBound = false;
  serverTimeGeneration = 0;
  warned = /* @__PURE__ */ new Set();
  constructor() {
    this.accountId = String(process.env.FARM_ACCOUNT_ID || "default");
    this.dataDir = path.join(ensureDataDir(), "tsdk", this.accountId);
  }
  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logWarn("ACE", message);
  }
  view() {
    if (!this.memory) throw new Error("TSDK \u5185\u5B58\u5C1A\u672A\u521D\u59CB\u5316");
    return new Uint8Array(this.memory.buffer);
  }
  ensureBounds(ptr, length) {
    const size = this.memory ? this.memory.buffer.byteLength : 0;
    if (!Number.isInteger(ptr) || !Number.isInteger(length) || ptr < 0 || length < 0 || ptr + length > size) {
      throw new RangeError(`TSDK \u5185\u5B58\u8D8A\u754C: ptr=${ptr}, length=${length}, size=${size}`);
    }
  }
  readCString(ptr, maxLength = 1024 * 1024) {
    if (!ptr) return "";
    const view = this.view();
    this.ensureBounds(ptr, 1);
    const limit = Math.min(view.length, ptr + maxLength);
    let end = ptr;
    while (end < limit && view[end] !== 0) end++;
    if (end >= limit) throw new Error("TSDK \u5B57\u7B26\u4E32\u672A\u6B63\u5E38\u7EC8\u6B62");
    return Buffer.from(view.subarray(ptr, end)).toString("utf8");
  }
  writeCString(value, ptr, capacity) {
    const data = Buffer.from(String(value ?? ""), "utf8");
    if (!ptr || capacity <= data.length) return 0;
    this.ensureBounds(ptr, capacity);
    const view = this.view();
    view.set(data, ptr);
    view[ptr + data.length] = 0;
    return ptr;
  }
  writeBytes(value, ptr, capacity) {
    const data = Buffer.from(value || []);
    if (!ptr || capacity < data.length) return 0;
    this.ensureBounds(ptr, capacity);
    this.view().set(data, ptr);
    return data.length;
  }
  resolveDataPath(input) {
    const relative = String(input || "").replaceAll("\\", "/").replace(/^\/+/, "");
    const root = path.resolve(this.dataDir);
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("TSDK \u6587\u4EF6\u8DEF\u5F84\u8D8A\u51FA\u8D26\u53F7\u76EE\u5F55");
    }
    return target;
  }
  getDeviceText() {
    const device = CONFIG.deviceInfo || {};
    const model = String(device.deviceId || `${os.type()} ${os.arch()}`);
    const platform = String(CONFIG.os || process.platform);
    const system = String(device.sysSoftware || os.release());
    return `${model};${platform};${system};Node.js;`;
  }
  createImports() {
    return {
      a: {
        a: (exprPtr, filePtr, line, funcPtr) => {
          const expr = this.readCString(exprPtr);
          const file = this.readCString(filePtr) || "unknown";
          const func = this.readCString(funcPtr);
          throw new Error(`TSDK assertion: ${expr} at ${file}:${line} ${func}`);
        },
        b: (filePtr, dataPtr, encodingPtr) => {
          try {
            const target = this.resolveDataPath(this.readCString(filePtr));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, this.readCString(dataPtr), this.readCString(encodingPtr) || "utf8");
            return 1;
          } catch (e) {
            this.warnOnce("write-file", `TSDK \u6587\u4EF6\u5199\u5165\u5931\u8D25: ${e.message}`);
            return 0;
          }
        },
        c: (ptr, capacity) => {
          const stack = new Error('stack trace').stack || "";
          return this.writeCString(stack, ptr, capacity) ? Buffer.byteLength(stack, "utf8") + 1 : 0;
        },
        d: (ptr, capacity) => this.writeCString(TSDK_VERSION, ptr, capacity),
        e: () => {
          this.warnOnce("acevm", "Node.js \u73AF\u5883\u4E0D\u63D0\u4F9B\u5C0F\u6E38\u620F ACEVM \u5B8C\u6574\u6027\u4E0A\u4E0B\u6587\uFF0C\u4F7F\u7528\u7A7A\u7ED3\u679C");
          return 0;
        },
        f: () => this.warnOnce("sensors", "Node.js \u73AF\u5883\u4E0D\u63D0\u4F9B\u89E6\u6478\u548C\u9640\u87BA\u4EEA\u6570\u636E"),
        g: (filePtr, outputPtr, capacity, encodingPtr) => {
          try {
            const data = fs.readFileSync(this.resolveDataPath(this.readCString(filePtr)), this.readCString(encodingPtr) || "utf8");
            return this.writeCString(data, outputPtr, capacity);
          } catch {
            return 0;
          }
        },
        h: (clockId, _low, _high, outputPtr) => {
          if (clockId < 0 || clockId > 3) return 28;
          const value = Math.round((clockId === 0 ? Date.now() : performance.now()) * 1e6);
          this.ensureBounds(outputPtr, 8);
          const view = new Uint32Array(this.memory.buffer);
          view[outputPtr >> 2] = value >>> 0;
          view[outputPtr + 4 >> 2] = Math.floor(value / 4294967296) >>> 0;
          return 0;
        },
        i: (ptr, capacity) => this.writeCString(`${this.dataDir}${path.sep}`, ptr, capacity),
        j: (ptr, capacity) => this.writeCString(this.getDeviceText(), ptr, capacity),
        k: (ptr, capacity) => this.writeBytes(RUNTIME_TABLE, ptr, capacity),
        l: () => 2,
        m: (ptr, capacity) => this.writeCString(MINI_PROGRAM_APP_ID, ptr, capacity),
        n: (ptr, capacity) => this.writeCString(MINI_PROGRAM_APP_ID, ptr, capacity),
        o: () => this.warnOnce("integrity-functions", "Node.js \u73AF\u5883\u4E0D\u63D0\u4F9B\u5C0F\u6E38\u620F\u51FD\u6570\u5B8C\u6574\u6027\u5217\u8868"),
        p: (filePtr) => {
          try {
            const stat = fs.statSync(this.resolveDataPath(this.readCString(filePtr)));
            return this.exports?.y(stat.mode, Math.min(2147483647, stat.size), Math.floor(stat.atimeMs), Math.floor(stat.mtimeMs)) || 0;
          } catch {
            return 0;
          }
        },
        q: (outputPtr) => {
          const generation = ++this.serverTimeGeneration;
          this.ensureBounds(outputPtr, 4);
          new Int32Array(this.memory.buffer)[outputPtr >> 2] = Math.floor(Date.now() / 1e3);
          https.get("https://api.anticheatexpert.com/test", { timeout: 3e3 }, (response) => {
            response.resume();
            if (generation !== this.serverTimeGeneration || !this.memory) return;
            const parsed = Date.parse(response.headers.date || "");
            new Int32Array(this.memory.buffer)[outputPtr >> 2] = parsed ? Math.floor(parsed / 1e3) : 0;
          }).on("error", () => {
          });
          return 1;
        },
        r: (size) => {
          throw new Error(`TSDK \u5185\u5B58\u6269\u5C55\u5931\u8D25: ${size}`);
        },
        s: () => Date.now(),
        t: (filePtr, dataPtr, encodingPtr) => {
          try {
            const target = this.resolveDataPath(this.readCString(filePtr));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.appendFileSync(target, this.readCString(dataPtr), this.readCString(encodingPtr) || "utf8");
            return 1;
          } catch {
            return 0;
          }
        },
        u: () => {
          throw new Error("TSDK aborted");
        },
        v: (ptr, length) => {
          try {
            this.ensureBounds(ptr, length);
            const report = JSON.parse(Buffer.from(this.view().subarray(ptr, ptr + length)).toString("utf8"));
            const request = https.request("https://api.anticheatexpert.com/tqos", {
              method: "POST",
              headers: report.headers || {},
              timeout: 5e3
            }, (response) => response.resume());
            request.on("error", (e) => this.warnOnce("tqos", `TSDK TQOS \u4E0A\u62A5\u5931\u8D25: ${e.message}`));
            request.end(typeof report.message === "string" ? report.message : JSON.stringify(report.message ?? {}));
            return 0;
          } catch (e) {
            this.warnOnce("tqos", `TSDK TQOS \u6570\u636E\u65E0\u6548: ${e.message}`);
            return 0;
          }
        }
      }
    };
  }
  async init() {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    if (this.destroyed) throw new Error("TSDK \u8FD0\u884C\u65F6\u5DF2\u9500\u6BC1");
    this.initPromise = (async () => {
      const wasmPath = getResourcePath("utils", "tsdk.wasm");
      const wasm = fs.readFileSync(wasmPath);
      const hash = crypto.createHash("sha256").update(wasm).digest("hex");
      if (hash !== TSDK_SHA256) throw new Error(`TSDK \u6587\u4EF6\u6821\u9A8C\u5931\u8D25: ${hash}`);
      fs.mkdirSync(this.dataDir, { recursive: true });
      const { instance } = await WebAssembly.instantiate(wasm, this.createImports());
      if (this.destroyed) throw new Error("TSDK \u521D\u59CB\u5316\u5DF2\u88AB\u53D6\u6D88");
      this.exports = instance.exports;
      this.memory = this.exports.w;
      if (!(this.memory instanceof WebAssembly.Memory)) throw new Error("TSDK memory \u5BFC\u51FA\u4E0D\u517C\u5BB9");
      for (const name of ["x", "y", "A", "B", "E", "G", "H", "M", "N", "O", "P", "aa", "ba", "ca", "fa"]) {
        if (typeof this.exports[name] !== "function") throw new Error(`TSDK \u7F3A\u5C11\u5BFC\u51FA: ${name}`);
      }
      const decryptSegment = this.exports.__mergewasm_shared____wasm_decrypt_strings;
      if (typeof decryptSegment !== "function") throw new Error("TSDK \u7F3A\u5C11 mergewasm \u6570\u636E\u89E3\u5BC6\u5BFC\u51FA");
      for (const [ptr, length] of MERGED_DATA_SEGMENTS) {
        this.ensureBounds(ptr, length);
        decryptSegment(ptr, length, MERGED_DATA_KEY);
      }
      this.exports.x();
      const appKey = this.allocCString(TSDK_APP_KEY);
      try {
        this.exports.G(TSDK_GAME_ID, appKey.ptr);
      } finally {
        this.free(appKey.ptr);
      }
      this.ready = true;
      log("ACE", `\u65B0\u7248 TSDK \u521D\u59CB\u5316\u6210\u529F: ${TSDK_VERSION}`);
    })().catch((e) => {
      this.ready = false;
      this.exports = null;
      this.memory = null;
      this.initPromise = null;
      throw e;
    });
    return this.initPromise;
  }
  assertReady() {
    if (!this.ready || !this.exports || !this.memory || this.destroyed) throw new Error("TSDK \u5C1A\u672A\u5C31\u7EEA");
  }
  alloc(length) {
    if (!this.exports) throw new Error("TSDK \u5C1A\u672A\u521D\u59CB\u5316");
    const size = Math.max(1, Math.floor(Number(length) || 0));
    const ptr = this.exports.A(size);
    if (!ptr) throw new Error(`TSDK \u5206\u914D\u5185\u5B58\u5931\u8D25: ${size}`);
    this.ensureBounds(ptr, size);
    return ptr;
  }
  allocBytes(value) {
    const data = Buffer.from(value || []);
    const ptr = this.alloc(data.length || 1);
    if (data.length) this.view().set(data, ptr);
    return { ptr, length: data.length };
  }
  allocCString(value) {
    const data = Buffer.from(String(value), "utf8");
    const ptr = this.alloc(data.length + 1);
    this.view().set(data, ptr);
    this.view()[ptr + data.length] = 0;
    return { ptr, length: data.length };
  }
  free(ptr) {
    if (ptr && this.exports) this.exports.B(ptr);
  }
  transform(value, decrypt = false) {
    this.assertReady();
    const input = this.allocBytes(value);
    try {
      (decrypt ? this.exports.ca : this.exports.ba)(input.ptr, input.length);
      this.ensureBounds(input.ptr, input.length);
      return Buffer.from(this.view().subarray(input.ptr, input.ptr + input.length));
    } finally {
      this.free(input.ptr);
    }
  }
  bindUser(openId) {
    this.assertReady();
    const value = String(openId || "").trim();
    if (!value || this.userBound) return;
    const input = this.allocCString(value);
    try {
      this.exports.G(TSDK_GAME_ID, input.ptr);
      this.userBound = true;
    } finally {
      this.free(input.ptr);
    }
  }
  getEncryptedInitInfo() {
    this.assertReady();
    const ptr = this.exports.H();
    return ptr ? this.readCString(ptr, 64 * 1024) : "";
  }
  getDataToServer() {
    this.assertReady();
    const lengthPtr = this.alloc(4);
    try {
      new Int32Array(this.memory.buffer)[lengthPtr >> 2] = 0;
      const dataPtr = this.exports.N(lengthPtr);
      const length = new Int32Array(this.memory.buffer)[lengthPtr >> 2];
      if (!dataPtr || length <= 0) return Buffer.alloc(0);
      this.ensureBounds(dataPtr, length);
      return Buffer.from(this.view().subarray(dataPtr, dataPtr + length));
    } finally {
      this.free(lengthPtr);
    }
  }
  sendDataFromServer(value) {
    this.assertReady();
    const input = this.allocBytes(value);
    try {
      this.exports.O(input.ptr, input.length);
    } finally {
      this.free(input.ptr);
    }
  }
  heartbeatTick() {
    this.assertReady();
    this.exports.M();
  }
  processReceivedData() {
    this.assertReady();
    this.exports.P();
  }
  sendStatus() {
    this.assertReady();
    this.exports.E();
  }
  detectSpeedHack(elapsedMs) {
    this.assertReady();
    this.exports.fa(Math.max(0, Math.floor(elapsedMs)));
  }
  destroy() {
    this.ready = false;
    this.destroyed = true;
    this.serverTimeGeneration++;
    this.exports = null;
    this.memory = null;
    this.initPromise = null;
  }
}
module.exports = {
  TsdkRuntime,
  TSDK_VERSION,
  TSDK_SHA256,
  MINI_PROGRAM_APP_ID,
  TSDK_GAME_ID
};
