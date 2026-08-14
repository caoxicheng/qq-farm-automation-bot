import type { LogEntry, RuntimeConfigSnapshot, RuntimeStatusSnapshot } from './domain';

export type WorkerApiMethod = string;
export type WxCredentialAction = 'refresh_code' | 'keepalive';

export type MasterToWorkerMessage =
    | { type: 'ping' }
    | { type: 'start'; config: { code?: string; platform?: string } }
    | { type: 'stop' }
    | { type: 'config_sync'; config: RuntimeConfigSnapshot }
    | { type: 'api_call'; id: number; method: WorkerApiMethod; args: unknown[] }
    | { type: 'wx_credential_response'; id: number; result?: unknown; error?: string };

export type WorkerToMasterMessage =
    | { type: 'pong' }
    | { type: 'status_sync'; data: RuntimeStatusSnapshot }
    | { type: 'stat_update'; data: { gold: number; exp: number } }
    | { type: 'log'; data: LogEntry }
    | { type: 'error'; error: string }
    | { type: 'wx_credential_request'; id: number; action: WxCredentialAction }
    | { type: 'ws_error'; code: number; message: string }
    | { type: 'reauth_required'; code: number; message: string }
    | { type: 'account_kicked'; reason: string }
    | { type: 'version_prefix_update'; prefix: string }
    | { type: 'api_response'; id: number; result?: unknown; error?: string }
    | { type: 'friend_blacklist_add'; gid: number; friendName?: string; reason?: string };

export type WorkerChannelMessage = MasterToWorkerMessage | WorkerToMasterMessage;

export function assertNever(message: never): never {
    throw new Error(`未处理的 Worker IPC 消息: ${JSON.stringify(message)}`);
}
