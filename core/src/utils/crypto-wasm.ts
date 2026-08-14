import { TsdkRuntime } from "./tsdk-runtime";

let runtime: TsdkRuntime | null = null;

function getRuntime(): TsdkRuntime {
  if (!runtime) runtime = new TsdkRuntime();
  return runtime;
}

async function initWasm(): Promise<void> {
  await getRuntime().init();
}

async function encryptBuffer(buffer: Uint8Array): Promise<Buffer> {
  await initWasm();
  return getRuntime().transform(buffer, false);
}

async function decryptBuffer(buffer: Uint8Array): Promise<Buffer> {
  await initWasm();
  return getRuntime().transform(buffer, true);
}

async function bindUser(openId: unknown): Promise<void> {
  await initWasm();
  getRuntime().bindUser(openId);
}

function getEncryptedInitInfo(): string {
  return getRuntime().getEncryptedInitInfo();
}

function getDataToServer(): Buffer {
  return getRuntime().getDataToServer();
}

function sendDataFromServer(data: Uint8Array): void {
  getRuntime().sendDataFromServer(data);
}

function heartbeatTick(): void {
  getRuntime().heartbeatTick();
}

function processReceivedData(): void {
  getRuntime().processReceivedData();
}

function sendStatus(): void {
  getRuntime().sendStatus();
}

function detectSpeedHack(elapsedMs: number): void {
  getRuntime().detectSpeedHack(elapsedMs);
}

function destroyWasm(): void {
  if (runtime) runtime.destroy();
  runtime = null;
}

export {
  bindUser,
  decryptBuffer,
  destroyWasm,
  detectSpeedHack,
  encryptBuffer,
  getDataToServer,
  getEncryptedInitInfo,
  heartbeatTick,
  initWasm,
  processReceivedData,
  sendDataFromServer,
  sendStatus
};
