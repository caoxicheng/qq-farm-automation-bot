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
const crypto_wasm_exports = {};
module.exports = __toCommonJS(crypto_wasm_exports);
const { TsdkRuntime } = require("./tsdk-runtime");
let runtime = null;
function getRuntime() {
  if (!runtime) runtime = new TsdkRuntime();
  return runtime;
}
async function initWasm() {
  await getRuntime().init();
}
async function encryptBuffer(buffer) {
  await initWasm();
  return getRuntime().transform(buffer, false);
}
async function decryptBuffer(buffer) {
  await initWasm();
  return getRuntime().transform(buffer, true);
}
async function bindUser(openId) {
  await initWasm();
  getRuntime().bindUser(openId);
}
function getEncryptedInitInfo() {
  return getRuntime().getEncryptedInitInfo();
}
function getDataToServer() {
  return getRuntime().getDataToServer();
}
function sendDataFromServer(data) {
  getRuntime().sendDataFromServer(data);
}
function heartbeatTick() {
  getRuntime().heartbeatTick();
}
function processReceivedData() {
  getRuntime().processReceivedData();
}
function sendStatus() {
  getRuntime().sendStatus();
}
function detectSpeedHack(elapsedMs) {
  getRuntime().detectSpeedHack(elapsedMs);
}
function destroyWasm() {
  if (runtime) runtime.destroy();
  runtime = null;
}
module.exports = {
  initWasm,
  encryptBuffer,
  decryptBuffer,
  bindUser,
  getEncryptedInitInfo,
  getDataToServer,
  sendDataFromServer,
  heartbeatTick,
  processReceivedData,
  sendStatus,
  detectSpeedHack,
  destroyWasm
};
