export type AccountId = string | number;

export interface AccountRecord {
    id: AccountId;
    name: string;
    username?: string;
    nick?: string;
    uin?: AccountId;
    qq?: AccountId;
    wxid?: string;
    code?: string;
    platform?: string;
    [key: string]: unknown;
}

export interface RuntimeConfigSnapshot {
    [key: string]: unknown;
}

export interface RuntimeStatusSnapshot {
    connection?: {
        connected?: boolean;
        [key: string]: unknown;
    };
    status?: {
        name?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface LogEntry {
    accountId?: AccountId;
    id?: AccountId;
    accountName?: string;
    time?: string;
    tag?: string;
    msg?: string;
    meta?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface ApiSuccess<T> {
    ok: true;
    data: T;
}

export interface ApiFailure {
    ok: false;
    error: string;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export interface PendingApiRequest<T = unknown> {
    resolve: (value: T) => void;
    reject: (reason: Error) => void;
}

export interface WorkerRecord {
    process: WorkerProcess;
    status: RuntimeStatusSnapshot | null;
    logs: LogEntry[];
    requests: Map<number, PendingApiRequest>;
    reqId: number;
    name: string;
    username: string;
    nick?: string;
    stopping: boolean;
    disconnectedSince: number;
    autoDeleteTriggered: boolean;
    wsError: { code: number; message: string; at: number } | null;
}

export interface WorkerProcess {
    send: (message: unknown, callback?: () => void) => unknown;
    kill: () => unknown;
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    once: (event: string, listener: (...args: unknown[]) => void) => unknown;
    exitCode?: number | null;
    signalCode?: string | null;
}
