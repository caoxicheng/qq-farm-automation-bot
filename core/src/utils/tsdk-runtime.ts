import crypto from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { CONFIG } from "../config/config";
import { ensureDataDir, getResourcePath } from "../config/runtime-paths";
const { log, logWarn } = require("./utils");

interface TsdkExports extends WebAssembly.Exports {
  w: WebAssembly.Memory;
  x: () => void;
  y: (mode: number, size: number, atimeMs: number, mtimeMs: number) => number;
  A: (size: number) => number;
  B: (pointer: number) => void;
  E: () => void;
  G: (gameId: number, valuePointer: number) => void;
  H: () => number;
  M: () => void;
  N: (lengthPointer: number) => number;
  O: (dataPointer: number, length: number) => void;
  P: () => void;
  aa: (...args: number[]) => number;
  ba: (dataPointer: number, length: number) => void;
  ca: (dataPointer: number, length: number) => void;
  fa: (elapsedMs: number) => void;
  __mergewasm_shared____wasm_decrypt_strings: (pointer: number, length: number, key: number) => void;
}

interface AllocatedValue {
  ptr: number;
  length: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function normalizeEncoding(value: string): BufferEncoding {
  return Buffer.isEncoding(value) ? value : "utf8";
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (headerValue === undefined || headerValue === null) continue;
    headers[key] = String(headerValue);
  }
  return headers;
}
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
  accountId: string;
  dataDir: string;
  memory: WebAssembly.Memory | null = null;
  exports: TsdkExports | null = null;
  initPromise: Promise<void> | null = null;
  ready = false;
  destroyed = false;
  userBound = false;
  serverTimeGeneration = 0;
  warned = /* @__PURE__ */ new Set<string>();
  constructor() {
    this.accountId = String(process.env.FARM_ACCOUNT_ID || "default");
    this.dataDir = path.join(ensureDataDir(), "tsdk", this.accountId);
  }
  warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logWarn("ACE", message);
  }
  view(): Uint8Array {
    if (!this.memory) throw new Error("TSDK \u5185\u5B58\u5C1A\u672A\u521D\u59CB\u5316");
    return new Uint8Array(this.memory.buffer);
  }
  ensureBounds(ptr: number, length: number): void {
    const size = this.memory ? this.memory.buffer.byteLength : 0;
    if (!Number.isInteger(ptr) || !Number.isInteger(length) || ptr < 0 || length < 0 || ptr + length > size) {
      throw new RangeError(`TSDK \u5185\u5B58\u8D8A\u754C: ptr=${ptr}, length=${length}, size=${size}`);
    }
  }
  readCString(ptr: number, maxLength = 1024 * 1024): string {
    if (!ptr) return "";
    const view = this.view();
    this.ensureBounds(ptr, 1);
    const limit = Math.min(view.length, ptr + maxLength);
    let end = ptr;
    while (end < limit && view[end] !== 0) end++;
    if (end >= limit) throw new Error("TSDK \u5B57\u7B26\u4E32\u672A\u6B63\u5E38\u7EC8\u6B62");
    return Buffer.from(view.subarray(ptr, end)).toString("utf8");
  }
  writeCString(value: unknown, ptr: number, capacity: number): number {
    const data = Buffer.from(String(value ?? ""), "utf8");
    if (!ptr || capacity <= data.length) return 0;
    this.ensureBounds(ptr, capacity);
    const view = this.view();
    view.set(data, ptr);
    view[ptr + data.length] = 0;
    return ptr;
  }
  writeBytes(value: Uint8Array | readonly number[], ptr: number, capacity: number): number {
    const data = Buffer.from(value || []);
    if (!ptr || capacity < data.length) return 0;
    this.ensureBounds(ptr, capacity);
    this.view().set(data, ptr);
    return data.length;
  }
  resolveDataPath(input: unknown): string {
    const relative = String(input || "").replaceAll("\\", "/").replace(/^\/+/, "");
    const root = path.resolve(this.dataDir);
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("TSDK \u6587\u4EF6\u8DEF\u5F84\u8D8A\u51FA\u8D26\u53F7\u76EE\u5F55");
    }
    return target;
  }
  getDeviceText(): string {
    const device = CONFIG.deviceInfo || {};
    const model = String(device.deviceId || `${os.type()} ${os.arch()}`);
    const platform = String(CONFIG.os || process.platform);
    const system = String(device.sysSoftware || os.release());
    return `${model};${platform};${system};Node.js;`;
  }
  createImports(): WebAssembly.Imports {
    return {
      a: {
        a: (exprPtr: number, filePtr: number, line: number, funcPtr: number) => {
          const expr = this.readCString(exprPtr);
          const file = this.readCString(filePtr) || "unknown";
          const func = this.readCString(funcPtr);
          throw new Error(`TSDK assertion: ${expr} at ${file}:${line} ${func}`);
        },
        b: (filePtr: number, dataPtr: number, encodingPtr: number) => {
          try {
            const target = this.resolveDataPath(this.readCString(filePtr));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const encoding = normalizeEncoding(this.readCString(encodingPtr) || "utf8");
            fs.writeFileSync(target, this.readCString(dataPtr), encoding);
            return 1;
          } catch (e) {
            this.warnOnce("write-file", `TSDK \u6587\u4EF6\u5199\u5165\u5931\u8D25: ${errorMessage(e)}`);
            return 0;
          }
        },
        c: (ptr: number, capacity: number) => {
          const stack = new Error('stack trace').stack || "";
          return this.writeCString(stack, ptr, capacity) ? Buffer.byteLength(stack, "utf8") + 1 : 0;
        },
        d: (ptr: number, capacity: number) => this.writeCString(TSDK_VERSION, ptr, capacity),
        e: () => {
          this.warnOnce("acevm", "Node.js \u73AF\u5883\u4E0D\u63D0\u4F9B\u5C0F\u6E38\u620F ACEVM \u5B8C\u6574\u6027\u4E0A\u4E0B\u6587\uFF0C\u4F7F\u7528\u7A7A\u7ED3\u679C");
          return 0;
        },
        f: () => this.warnOnce("sensors", "Node.js \u73AF\u5883\u4E0D\u63D0\u4F9B\u89E6\u6478\u548C\u9640\u87BA\u4EEA\u6570\u636E"),
        g: (filePtr: number, outputPtr: number, capacity: number, encodingPtr: number) => {
          try {
            const encoding = normalizeEncoding(this.readCString(encodingPtr) || "utf8");
            const data = fs.readFileSync(this.resolveDataPath(this.readCString(filePtr)), encoding);
            return this.writeCString(data, outputPtr, capacity);
          } catch {
            return 0;
          }
        },
        h: (clockId: number, _low: number, _high: number, outputPtr: number) => {
          if (clockId < 0 || clockId > 3) return 28;
          const value = Math.round((clockId === 0 ? Date.now() : performance.now()) * 1e6);
          this.ensureBounds(outputPtr, 8);
          const memory = this.memory;
          if (!memory) throw new Error("TSDK \u5185\u5B58\u5C1A\u672A\u521D\u59CB\u5316");
          const view = new Uint32Array(memory.buffer);
          view[outputPtr >> 2] = value >>> 0;
          view[outputPtr + 4 >> 2] = Math.floor(value / 4294967296) >>> 0;
          return 0;
        },
        i: (ptr: number, capacity: number) => this.writeCString(`${this.dataDir}${path.sep}`, ptr, capacity),
        j: (ptr: number, capacity: number) => this.writeCString(this.getDeviceText(), ptr, capacity),
        k: (ptr: number, capacity: number) => this.writeBytes(RUNTIME_TABLE, ptr, capacity),
        l: () => 2,
        m: (ptr: number, capacity: number) => this.writeCString(MINI_PROGRAM_APP_ID, ptr, capacity),
        n: (ptr: number, capacity: number) => this.writeCString(MINI_PROGRAM_APP_ID, ptr, capacity),
        o: () => this.warnOnce("integrity-functions", "Node.js \u73AF\u5883\u4E0D\u63D0\u4F9B\u5C0F\u6E38\u620F\u51FD\u6570\u5B8C\u6574\u6027\u5217\u8868"),
        p: (filePtr: number) => {
          try {
            const stat = fs.statSync(this.resolveDataPath(this.readCString(filePtr)));
            return this.exports?.y(stat.mode, Math.min(2147483647, stat.size), Math.floor(stat.atimeMs), Math.floor(stat.mtimeMs)) || 0;
          } catch {
            return 0;
          }
        },
        q: (outputPtr: number) => {
          const generation = ++this.serverTimeGeneration;
          this.ensureBounds(outputPtr, 4);
          const currentMemory = this.memory;
          if (!currentMemory) throw new Error("TSDK \u5185\u5B58\u5C1A\u672A\u521D\u59CB\u5316");
          new Int32Array(currentMemory.buffer)[outputPtr >> 2] = Math.floor(Date.now() / 1e3);
          https.get("https://api.anticheatexpert.com/test", { timeout: 3e3 }, (response) => {
            response.resume();
            const memory = this.memory;
            if (generation !== this.serverTimeGeneration || !memory) return;
            const parsed = Date.parse(response.headers.date || "");
            new Int32Array(memory.buffer)[outputPtr >> 2] = parsed ? Math.floor(parsed / 1e3) : 0;
          }).on("error", () => {
          });
          return 1;
        },
        r: (size: number) => {
          throw new Error(`TSDK \u5185\u5B58\u6269\u5C55\u5931\u8D25: ${size}`);
        },
        s: () => Date.now(),
        t: (filePtr: number, dataPtr: number, encodingPtr: number) => {
          try {
            const target = this.resolveDataPath(this.readCString(filePtr));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const encoding = normalizeEncoding(this.readCString(encodingPtr) || "utf8");
            fs.appendFileSync(target, this.readCString(dataPtr), encoding);
            return 1;
          } catch {
            return 0;
          }
        },
        u: () => {
          throw new Error("TSDK aborted");
        },
        v: (ptr: number, length: number) => {
          try {
            this.ensureBounds(ptr, length);
            const parsed = JSON.parse(Buffer.from(this.view().subarray(ptr, ptr + length)).toString("utf8")) as unknown;
            const report = parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? parsed as Record<string, unknown>
              : {};
            const request = https.request("https://api.anticheatexpert.com/tqos", {
              method: "POST",
              headers: normalizeHeaders(report.headers),
              timeout: 5e3
            }, (response) => response.resume());
            request.on("error", (e) => this.warnOnce("tqos", `TSDK TQOS \u4E0A\u62A5\u5931\u8D25: ${e.message}`));
            request.end(typeof report.message === "string" ? report.message : JSON.stringify(report.message ?? {}));
            return 0;
          } catch (e) {
            this.warnOnce("tqos", `TSDK TQOS \u6570\u636E\u65E0\u6548: ${errorMessage(e)}`);
            return 0;
          }
        }
      }
    };
  }
  async init(): Promise<void> {
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
      const rawExports = instance.exports;
      const memory = rawExports.w;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("TSDK memory \u5BFC\u51FA\u4E0D\u517C\u5BB9");
      for (const name of ["x", "y", "A", "B", "E", "G", "H", "M", "N", "O", "P", "aa", "ba", "ca", "fa"]) {
        if (typeof rawExports[name] !== "function") throw new Error(`TSDK \u7F3A\u5C11\u5BFC\u51FA: ${name}`);
      }
      const decryptSegment = rawExports.__mergewasm_shared____wasm_decrypt_strings;
      if (typeof decryptSegment !== "function") throw new Error("TSDK \u7F3A\u5C11 mergewasm \u6570\u636E\u89E3\u5BC6\u5BFC\u51FA");
      const wasmExports = rawExports as unknown as TsdkExports;
      this.exports = wasmExports;
      this.memory = memory;
      for (const [ptr, length] of MERGED_DATA_SEGMENTS) {
        this.ensureBounds(ptr, length);
        decryptSegment(ptr, length, MERGED_DATA_KEY);
      }
      wasmExports.x();
      const appKey = this.allocCString(TSDK_APP_KEY);
      try {
        wasmExports.G(TSDK_GAME_ID, appKey.ptr);
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
  readyState(): { exports: TsdkExports; memory: WebAssembly.Memory } {
    if (!this.ready || !this.exports || !this.memory || this.destroyed) throw new Error("TSDK \u5C1A\u672A\u5C31\u7EEA");
    return { exports: this.exports, memory: this.memory };
  }
  alloc(length: unknown): number {
    if (!this.exports) throw new Error("TSDK \u5C1A\u672A\u521D\u59CB\u5316");
    const size = Math.max(1, Math.floor(Number(length) || 0));
    const ptr = this.exports.A(size);
    if (!ptr) throw new Error(`TSDK \u5206\u914D\u5185\u5B58\u5931\u8D25: ${size}`);
    this.ensureBounds(ptr, size);
    return ptr;
  }
  allocBytes(value: Uint8Array | readonly number[]): AllocatedValue {
    const data = Buffer.from(value || []);
    const ptr = this.alloc(data.length || 1);
    if (data.length) this.view().set(data, ptr);
    return { ptr, length: data.length };
  }
  allocCString(value: unknown): AllocatedValue {
    const data = Buffer.from(String(value), "utf8");
    const ptr = this.alloc(data.length + 1);
    this.view().set(data, ptr);
    this.view()[ptr + data.length] = 0;
    return { ptr, length: data.length };
  }
  free(ptr: number): void {
    if (ptr && this.exports) this.exports.B(ptr);
  }
  transform(value: Uint8Array, decrypt = false): Buffer {
    const { exports } = this.readyState();
    const input = this.allocBytes(value);
    try {
      (decrypt ? exports.ca : exports.ba)(input.ptr, input.length);
      this.ensureBounds(input.ptr, input.length);
      return Buffer.from(this.view().subarray(input.ptr, input.ptr + input.length));
    } finally {
      this.free(input.ptr);
    }
  }
  bindUser(openId: unknown): void {
    const { exports } = this.readyState();
    const value = String(openId || "").trim();
    if (!value || this.userBound) return;
    const input = this.allocCString(value);
    try {
      exports.G(TSDK_GAME_ID, input.ptr);
      this.userBound = true;
    } finally {
      this.free(input.ptr);
    }
  }
  getEncryptedInitInfo(): string {
    const { exports } = this.readyState();
    const ptr = exports.H();
    return ptr ? this.readCString(ptr, 64 * 1024) : "";
  }
  getDataToServer(): Buffer {
    const { exports, memory } = this.readyState();
    const lengthPtr = this.alloc(4);
    try {
      new Int32Array(memory.buffer)[lengthPtr >> 2] = 0;
      const dataPtr = exports.N(lengthPtr);
      const length = new Int32Array(memory.buffer)[lengthPtr >> 2];
      if (!dataPtr || length <= 0) return Buffer.alloc(0);
      this.ensureBounds(dataPtr, length);
      return Buffer.from(this.view().subarray(dataPtr, dataPtr + length));
    } finally {
      this.free(lengthPtr);
    }
  }
  sendDataFromServer(value: Uint8Array): void {
    const { exports } = this.readyState();
    const input = this.allocBytes(value);
    try {
      exports.O(input.ptr, input.length);
    } finally {
      this.free(input.ptr);
    }
  }
  heartbeatTick(): void {
    this.readyState().exports.M();
  }
  processReceivedData(): void {
    this.readyState().exports.P();
  }
  sendStatus(): void {
    this.readyState().exports.E();
  }
  detectSpeedHack(elapsedMs: number): void {
    this.readyState().exports.fa(Math.max(0, Math.floor(elapsedMs)));
  }
  destroy(): void {
    this.ready = false;
    this.destroyed = true;
    this.serverTimeGeneration++;
    this.exports = null;
    this.memory = null;
    this.initPromise = null;
  }
}
export {
  MINI_PROGRAM_APP_ID,
  TSDK_GAME_ID,
  TSDK_SHA256,
  TSDK_VERSION,
  TsdkRuntime
};
