import * as cryptoWasm from '../utils/crypto-wasm';
import { types } from '../utils/proto';
import { log, logWarn } from '../utils/utils';
import { createScheduler } from './scheduler';
import { asRecord, errorMessage } from './service-boundaries';

type AceRequestSender = (
  serviceName: string,
  methodName: string,
  body: Uint8Array,
  timeout: number,
) => Promise<{ body: Uint8Array }>;
const aceScheduler = createScheduler("ace");
let requestRunning = false;
let readyLogged = false;
let sendRequest: AceRequestSender | null = null;
let lastSpeedCheckAt = 0;
async function sendAntiData(): Promise<void> {
  if (!sendRequest || requestRunning) return;
  const data = cryptoWasm.getDataToServer();
  if (!data || data.length === 0) return;
  requestRunning = true;
  try {
    const body = types.AntiDataRequest.encode(types.AntiDataRequest.create({ data })).finish();
    const { body: replyBody } = await sendRequest("gamepb.acepb.AceService", "AntiData", Buffer.from(body), 1e4);
    const reply = asRecord(types.AntiDataReply.decode(replyBody));
    const result = reply.result;
    if (result instanceof Uint8Array && result.length > 0) {
      cryptoWasm.sendDataFromServer(Buffer.from(result));
      if (!readyLogged) {
        readyLogged = true;
        log("ACE", `AntiData \u94FE\u8DEF\u6B63\u5E38: \u4E0A\u62A5 ${data.length} \u5B57\u8282\uFF0C\u56DE\u704C ${result.length} \u5B57\u8282`);
      }
    }
  } catch (error) {
    logWarn("ACE", `AntiData \u4E0A\u62A5\u5931\u8D25: ${errorMessage(error)}`);
  } finally {
    requestRunning = false;
  }
}
function startAceRuntime(sender: AceRequestSender): void {
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
function stopAceRuntime(destroyWasm = false): void {
  aceScheduler.clearAll();
  requestRunning = false;
  readyLogged = false;
  sendRequest = null;
  lastSpeedCheckAt = 0;
  if (destroyWasm) cryptoWasm.destroyWasm();
}
export {
  sendAntiData,
  startAceRuntime,
  stopAceRuntime
};
