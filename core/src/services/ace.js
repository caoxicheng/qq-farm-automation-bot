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
const ace_exports = {};
module.exports = __toCommonJS(ace_exports);
const { createScheduler } = require("./scheduler");
const { types } = require("../utils/proto");
const cryptoWasm = require("../utils/crypto-wasm");
const { log, logWarn } = require("../utils/utils");
const aceScheduler = createScheduler("ace");
let requestRunning = false;
let readyLogged = false;
let sendRequest = null;
let lastSpeedCheckAt = 0;
async function sendAntiData() {
  if (!sendRequest || requestRunning) return;
  const data = cryptoWasm.getDataToServer();
  if (!data || data.length === 0) return;
  requestRunning = true;
  try {
    const body = types.AntiDataRequest.encode(types.AntiDataRequest.create({ data })).finish();
    const { body: replyBody } = await sendRequest("gamepb.acepb.AceService", "AntiData", Buffer.from(body), 1e4);
    const reply = types.AntiDataReply.decode(replyBody);
    if (reply.result && reply.result.length > 0) {
      cryptoWasm.sendDataFromServer(Buffer.from(reply.result));
      if (!readyLogged) {
        readyLogged = true;
        log("ACE", `AntiData \u94FE\u8DEF\u6B63\u5E38: \u4E0A\u62A5 ${data.length} \u5B57\u8282\uFF0C\u56DE\u704C ${reply.result.length} \u5B57\u8282`);
      }
    }
  } catch (e) {
    logWarn("ACE", `AntiData \u4E0A\u62A5\u5931\u8D25: ${e.message}`);
  } finally {
    requestRunning = false;
  }
}
function startAceRuntime(sender) {
  stopAceRuntime(false);
  sendRequest = sender;
  readyLogged = false;
  lastSpeedCheckAt = Date.now();
  aceScheduler.setIntervalTask("anti_data", 5e3, sendAntiData, { preventOverlap: true });
  aceScheduler.setIntervalTask("process_received_data", 5e3, () => cryptoWasm.processReceivedData());
  aceScheduler.setIntervalTask("heartbeat_tick", 25e3, () => cryptoWasm.heartbeatTick());
  aceScheduler.setIntervalTask("speed_check", 3e4, () => {
    const now = Date.now();
    cryptoWasm.detectSpeedHack(now - lastSpeedCheckAt);
    lastSpeedCheckAt = now;
  });
  aceScheduler.setIntervalTask("status_report", 15e4, () => cryptoWasm.sendStatus());
}
function stopAceRuntime(destroyWasm = false) {
  aceScheduler.clearAll();
  requestRunning = false;
  readyLogged = false;
  sendRequest = null;
  lastSpeedCheckAt = 0;
  if (destroyWasm) cryptoWasm.destroyWasm();
}
module.exports = {
  sendAntiData,
  startAceRuntime,
  stopAceRuntime
};
