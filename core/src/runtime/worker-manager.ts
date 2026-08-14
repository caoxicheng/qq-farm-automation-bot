import type { Scheduler } from '../services/scheduler';
import type {
    AccountId,
    AccountRecord,
    LogEntry,
    RuntimeConfigSnapshot,
    RuntimeStatusSnapshot,
    WorkerProcess,
    WorkerRecord,
} from '../types/domain';
import type { WorkerToMasterMessage } from '../types/ipc';
import { assertNever } from '../types/ipc';

const { createScheduler } = require('../services/scheduler');
const { getVersionPrefix } = require('../config/config');

type DynamicRecord = Record<string, any>;

interface ReauthState {
    code: number;
    message: string;
    at: number;
}

interface AutoReloginConfig {
    enabled: boolean;
    maxPerDay: number;
    kickWindowMinutes: number;
    delayMinutes: number;
    loginFailWindowSec: number;
}

interface ReloginState {
    dayKey: string;
    count: number;
    disabled: boolean;
    lastReloginAt: number;
}

interface ThreadWorkerProcess extends WorkerProcess {
    postMessage: (message: unknown) => void;
    terminate: () => Promise<number>;
    send: (message: unknown, callback?: () => void) => unknown;
}

type WorkerThreadConstructor = new (scriptPath: string, options: DynamicRecord) => ThreadWorkerProcess;
type ForkFactory = (scriptPath: string, args: string[], options: DynamicRecord) => WorkerProcess;

interface ProcessReference {
    pkg?: unknown;
    execPath: string;
    env: NodeJS.ProcessEnv;
}

interface WorkerManagerOptions {
    fork: ForkFactory;
    WorkerThread?: WorkerThreadConstructor;
    runtimeMode?: string;
    processRef: ProcessReference;
    mainEntryPath: string;
    workerScriptPath: string;
    workers: Record<string, WorkerRecord>;
    globalLogs: LogEntry[];
    log: (tag: string, message: string, extra?: DynamicRecord) => void;
    addAccountLog: (action: string, message: string, accountId?: AccountId | '', accountName?: string, extra?: DynamicRecord) => void;
    normalizeStatusForPanel: (data: unknown, accountId: AccountId, accountName: string) => RuntimeStatusSnapshot;
    buildConfigSnapshotForAccount: (accountId: AccountId) => RuntimeConfigSnapshot;
    getOfflineAutoDeleteMs: (username?: string) => number;
    triggerOfflineReminder: (payload: DynamicRecord) => Promise<void> | void;
    addOrUpdateAccount: (account: DynamicRecord) => unknown;
    deleteAccount: (accountId: AccountId) => unknown;
    getAutoRelogin?: (accountId: AccountId) => AutoReloginConfig | null;
    getAccounts?: () => { accounts?: AccountRecord[] };
    reauthRequiredStates?: Map<string, ReauthState>;
    onStatusSync?: (accountId: AccountId, status: RuntimeStatusSnapshot, accountName: string) => void;
    onWorkerLog?: (entry: LogEntry, accountId: AccountId, accountName: string) => void;
    scheduler?: Scheduler;
    now?: () => number;
}

export interface WorkerManager {
    startWorker: (account: AccountRecord, options?: { preserveWatchdogRestartCount?: boolean }) => boolean;
    stopWorker: (accountId: AccountId) => void;
    restartWorker: (account: AccountRecord) => boolean | void;
    callWorkerApi: (accountId: AccountId, method: string, ...args: unknown[]) => Promise<unknown>;
    resetAutoReloginState: (accountId: AccountId) => void;
}

const WORKER_MESSAGE_TYPES = new Set<WorkerToMasterMessage['type']>([
    'pong',
    'status_sync',
    'stat_update',
    'log',
    'error',
    'wx_credential_request',
    'ws_error',
    'reauth_required',
    'account_kicked',
    'version_prefix_update',
    'api_response',
    'friend_blacklist_add',
]);

function isWorkerToMasterMessage(value: unknown): value is WorkerToMasterMessage {
    if (!value || typeof value !== 'object') return false;
    const type = (value as { type?: unknown }).type;
    return typeof type === 'string' && WORKER_MESSAGE_TYPES.has(type as WorkerToMasterMessage['type']);
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown error');
}

function createWorkerManager(options: WorkerManagerOptions): WorkerManager {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        addOrUpdateAccount,
        deleteAccount,
        getAutoRelogin,
        getAccounts,
        reauthRequiredStates = new Map(),
        onStatusSync,
        onWorkerLog,
        scheduler,
        now = Date.now,
    } = options;
    const managerScheduler = scheduler || createScheduler('worker_manager');
    const useThreadRuntime = runtimeMode === 'thread' && !processRef.pkg && typeof WorkerThread === 'function';

    // ============ 自动重登状态跟踪 ============
    // accountId -> { dayKey, count, disabled, lastReloginAt }
    const reloginState = new Map<AccountId, ReloginState>();

    function dayKeyOf(d: Date): string {
        const pad = (n: number): string => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    function getReloginState(accountId: AccountId): ReloginState {
        const now = new Date();
        const key = dayKeyOf(now);
        let st = reloginState.get(accountId);
        if (!st || st.dayKey !== key) {
            st = { dayKey: key, count: 0, disabled: false, lastReloginAt: 0 };
            reloginState.set(accountId, st);
        }
        return st;
    }

    function resetAutoReloginState(accountId: AccountId): void {
        reloginState.delete(accountId);
    }

    // 账号被踢下线后的自动重登调度
    function scheduleAutoRelogin(accountId: AccountId, reason: string): void {
        const cfg = typeof getAutoRelogin === 'function' ? getAutoRelogin(accountId) : null;
        if (!cfg || !cfg.enabled) return;

        const st = getReloginState(accountId);
        const name = (workers[accountId] && workers[accountId].name) || accountId;

        if (st.disabled) {
            log('系统', `账号 ${name} 当天自动重登已禁用（此前触发禁用条件），跳过`, { accountId: String(accountId) });
            return;
        }

        if (st.count >= cfg.maxPerDay) {
            log('系统', `账号 ${name} 今日自动重登已达上限（${cfg.maxPerDay} 次），跳过`, { accountId: String(accountId) });
            return;
        }

        // 上次自动重登后窗口内再次被踢 → 判定手机还在占用，禁用当天自动重登
        if (st.lastReloginAt > 0) {
            const kickWindowMs = cfg.kickWindowMinutes * 60 * 1000;
            const sinceRelogin = Date.now() - st.lastReloginAt;
            if (sinceRelogin < kickWindowMs) {
                st.disabled = true;
                log('系统', `账号 ${name} 自动重登后 ${Math.round(sinceRelogin / 1000)}s 内再次被踢，判定手机占用，禁用当天自动重登`, { accountId: String(accountId) });
                return;
            }
        }

        const delayMs = cfg.delayMinutes * 60 * 1000;
        log('系统', `账号 ${name} 将于 ${cfg.delayMinutes} 分钟后自动重登（今日第 ${st.count + 1}/${cfg.maxPerDay} 次），原因: ${reason}`, { accountId: String(accountId) });

        managerScheduler.setTimeoutTask(`autorelogin_${accountId}`, delayMs, async () => {
            const accounts = (typeof getAccounts === 'function' ? getAccounts() : { accounts: [] });
            const acc = (accounts.accounts || []).find((account: AccountRecord) => String(account.id) === String(accountId));
            if (!acc) {
                log('系统', `自动重登失败：账号 ${accountId} 不存在或已删除`, { accountId: String(accountId) });
                return;
            }
            if (workers[accountId]) {
                log('系统', `自动重登跳过：账号 ${acc.name} 已在运行`, { accountId: String(accountId) });
                return;
            }
            // 微信账号：重登前刷新登录 code（与手动启动一致，避免旧 code 过期导致握手 400）
            if (acc.platform === 'wx' && acc.wxid) {
                try {
                    const { getFarmCode } = require('../services/wx-login-adapter');
                    const refresh = await getFarmCode(acc.wxid, { accountId: acc.id });
                    if (refresh.Success && refresh.Data && refresh.Data.code) {
                        const { addOrUpdateAccount } = require('../models/store');
                        addOrUpdateAccount({ id: acc.id, code: refresh.Data.code });
                        acc.code = refresh.Data.code;
                        log('系统', `账号 ${acc.name} 自动重登已刷新登录 code`, { accountId: String(accountId) });
                    } else {
                        log('系统', `账号 ${acc.name} 自动重登刷新 code 失败，降级用旧 code: ${refresh.Message || '未知'}`, { accountId: String(accountId) });
                    }
                } catch (refreshErr) {
                    log('系统', `账号 ${acc.name} 自动重登刷新 code 出错，降级用旧 code: ${errorMessage(refreshErr)}`, { accountId: String(accountId) });
                }
            }
            const cur = getReloginState(accountId);
            cur.count += 1;
            cur.lastReloginAt = Date.now();
            log('系统', `账号 ${acc.name} 自动重登中...`, { accountId: String(accountId) });
            startWorker(acc);
        });
    }

    function createThreadWorker(account: AccountRecord): WorkerProcess {
        if (!WorkerThread) throw new Error('Worker Thread runtime is unavailable');
        const worker = new WorkerThread(workerScriptPath, {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread',
                versionPrefix: getVersionPrefix(),
            },
        });
        // 与 child_process 保持同形接口
        worker.send = (payload: unknown) => worker.postMessage(payload);
        worker.kill = () => worker.terminate().catch(() => {}); // terminate 返回 Promise，吞掉罕见 rejection
        return worker;
    }

    function createForkWorker(account: AccountRecord): WorkerProcess {
        if (processRef.pkg) {
            // 打包后也走 fork + execPath，确保 IPC 通道可用
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: { ...processRef.env, FARM_WORKER: '1', FARM_ACCOUNT_ID: String(account.id || ''), FARM_VERSION_PREFIX: getVersionPrefix() },
            });
        }
        return fork(workerScriptPath, [], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...processRef.env, FARM_ACCOUNT_ID: String(account.id || ''), FARM_VERSION_PREFIX: getVersionPrefix() },
        });
    }

    function createWorkerProcess(account: AccountRecord): WorkerProcess {
        if (useThreadRuntime) return createThreadWorker(account);
        return createForkWorker(account);
    }

    // watchdog 卡死重启计数（连续 3 次停止自动重启；手动启动清零）
    const watchdogRestartCounts = new Map<AccountId, number>();

    function startWorker(account: AccountRecord, startOptions: { preserveWatchdogRestartCount?: boolean } = {}): boolean {
        if (!account || !account.id) return false;
        if (workers[account.id]) return false; // 已运行
        if (!startOptions.preserveWatchdogRestartCount) {
            watchdogRestartCounts.delete(account.id); // 手动/自动启动都重置计数
        }

        log('系统', `正在启动账号: ${account.name}`, { accountId: String(account.id), accountName: account.name });

        let child: WorkerProcess;
        try {
            child = createWorkerProcess(account);
        } catch (err) {
            const reason = errorMessage(err);
            log('错误', `账号 ${account.name} 启动失败: ${reason}`, { accountId: String(account.id), accountName: account.name });
            addAccountLog('start_failed', `账号 ${account.name} 启动失败`, account.id, account.name, { reason });
            return false;
        }

        workers[account.id] = {
            process: child,
            status: null, // 最新状态快照
            logs: [],
            requests: new Map(), // pending API requests
            reqId: 1,
            name: account.name,
            username: account.username || '', // 保存用户名用于下线提醒
            stopping: false,
            disconnectedSince: 0,
            autoDeleteTriggered: false,
            wsError: reauthRequiredStates.get(String(account.id)) || null,
        };

        // 发送启动指令
        child.send({
            type: 'start',
            config: {
                code: account.code,
                platform: account.platform,
            },
        });
        child.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(account.id) });

        let lastPongAt = now();
        // 监听消息
        child.on('message', (msg: unknown) => {
            if (!isWorkerToMasterMessage(msg)) {
                log('错误', `账号 ${account.name} 收到无效 Worker 消息`, { accountId: String(account.id) });
                return;
            }
            // watchdog pong：主线程探活响应（worker 事件循环活着）
            if (msg && msg.type === 'pong') {
                lastPongAt = now();
                return;
            }
            handleWorkerMessage(account.id, msg);
        });

        // watchdog：worker 卡死检测（事件循环同步阻塞时，worker 内的心跳/日志全停，主线程 ping 兜底）
        // 每 30s ping 一次；90s 无 pong 判定卡死 → 终止并自动重启（挂机自愈；连续 3 次卡死重启后停止，防死循环）
        const watchdogKey = `watchdog_${account.id}`;
        managerScheduler.clear(watchdogKey);
        managerScheduler.setIntervalTask(watchdogKey, 30000, () => {
            const current = workers[account.id];
            if (!current || current.stopping || current.process !== child) return;
            const idleMs = now() - lastPongAt;
            if (idleMs >= 90000) {
                const cnt = (watchdogRestartCounts.get(account.id) || 0) + 1;
                watchdogRestartCounts.set(account.id, cnt);
                log('系统', `账号 ${account.name} worker 无响应 ${Math.round(idleMs / 1000)}s，判定卡死（第 ${cnt} 次），强制重启`, { accountId: String(account.id), accountName: account.name });
                current.stopping = true; // 避免 exit 处理误判自动重登失败
                try { child.kill(); } catch {}
                delete workers[account.id];
                managerScheduler.setTimeoutTask(`watchdog_restart_${account.id}`, 3000, () => {
                    if ((watchdogRestartCounts.get(account.id) || 0) > 3) {
                        log('系统', `账号 ${account.name} 卡死重启超过 3 次，停止自动重启（请检查网络/凭证或手动启动）`, { accountId: String(account.id), accountName: account.name });
                        watchdogRestartCounts.delete(account.id);
                        return;
                    }
                    startWorker(account, { preserveWatchdogRestartCount: true });
                });
            } else {
                try { child.send({ type: 'ping' }); } catch {}
            }
        });

        child.on('error', (err: unknown) => {
            log('系统', `账号 ${account.name} 子进程启动失败: ${errorMessage(err)}`, { accountId: String(account.id), accountName: account.name });
        });

        child.on('exit', (code: unknown, signal: unknown) => {
            const current = workers[account.id];
            const displayName = (current && current.name) || account.name;
            log('系统', `账号 ${displayName} 进程退出 (code=${code}, signal=${signal || 'none'})`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: useThreadRuntime ? 'thread' : 'fork',
            });

            managerScheduler.clear(`force_kill_${account.id}`);
            managerScheduler.clear(`restart_fallback_${account.id}`);
            // 仅当退出的是当前 worker 时才清 watchdog（旧 child 的 exit 延迟到达时不能清新 worker 的）
            if (current && current.process === child) {
                managerScheduler.clear(`watchdog_${account.id}`);
            }

            // 自动重登失败检测：自动重登启动后短时间内进程异常退出（登录失败），禁用当天自动重登
            // 正常停止（stopWorker 设置 stopping=true）不会触发；被踢后 worker 自身退出也是 stopping=true
            if (current && !current.stopping) {
                const st = reloginState.get(account.id);
                if (st && st.lastReloginAt > 0) {
                    const cfg = (typeof getAutoRelogin === 'function') ? getAutoRelogin(account.id) : null;
                    const failWindowMs = ((cfg && cfg.loginFailWindowSec) || 60) * 1000;
                    const elapsed = Date.now() - st.lastReloginAt;
                    if (elapsed < failWindowMs) {
                        st.disabled = true;
                        log('系统', `账号 ${displayName} 自动重登后 ${Math.round(elapsed / 1000)}s 内进程异常退出（疑似登录失败），禁用当天自动重登`, { accountId: String(account.id) });
                    }
                }
            }

            if (current && current.requests && current.requests.size > 0) {
                for (const [reqId, req] of current.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${account.id}_${reqId}`);
                    try {
                        req.reject(new Error('Worker exited'));
                    } catch {}
                }
                current.requests.clear();
            }

            if (current && current.process === child) {
                delete workers[account.id];
            }
        });
        return true;
    }

    function stopWorker(accountId: AccountId): void {
        // 取消 watchdog 待重启（worker 可能已被 watchdog 删除——提前 return 也要清，否则 3s 内用户停止会被重启覆盖）
        managerScheduler.clear(`watchdog_restart_${accountId}`);
        const worker = workers[accountId];
        if (!worker) return;

        const proc = worker.process;
        worker.stopping = true;
        worker.process.send({ type: 'stop' });
        // process.kill will happen in 'exit' handler, or we can force it
        managerScheduler.setTimeoutTask(`force_kill_${accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === proc) {
                current.process.kill();
                delete workers[accountId];
            }
        });
    }

    function restartWorker(account: AccountRecord): boolean | void {
        if (!account) return;
        const accountId = account.id;
        const worker = workers[accountId];
        if (!worker) return startWorker(account);
        const proc = worker.process;
        let started = false;
        const startOnce = (): boolean | void => {
            if (started) return;
            started = true;
            managerScheduler.clear(`restart_fallback_${accountId}`);
            const current = workers[accountId];
            if (!current) return startWorker(account);
            if (current.process !== proc) return;
            delete workers[accountId];
            startWorker(account);
        };
        const killIfStale = (): boolean => {
            const current = workers[accountId];
            if (!current || current.process !== proc) return false;
            try {
                current.process.kill();
            } catch {}
            delete workers[accountId];
            return true;
        };
        if (typeof proc.exitCode === 'number' || proc.signalCode) {
            return startOnce();
        }
        proc.once('exit', startOnce);
        stopWorker(accountId);
        managerScheduler.setTimeoutTask(`restart_fallback_${accountId}`, 1500, () => {
            if (started) return;
            killIfStale();
            startOnce();
        });
    }

    function handleWorkerMessage(accountId: AccountId, msg: WorkerToMasterMessage): void {
        const worker = workers[accountId];
        if (!worker) return;

        if (msg.type === 'status_sync') {
            // 合并状态
            worker.status = normalizeStatusForPanel(msg.data, accountId, worker.name);
            const connected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (connected) {
                worker.disconnectedSince = 0;
                worker.autoDeleteTriggered = false;
                worker.wsError = null;
                reauthRequiredStates.delete(String(accountId));
            }
            worker.status = {
                ...worker.status,
                wsError: worker.wsError || reauthRequiredStates.get(String(accountId)) || null,
            };
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, worker.status, worker.name);
            }

            // 尝试更新昵称到 store
            if (msg.data && msg.data.status && msg.data.status.name) {
                const newNick = String(msg.data.status.name).trim();
                // 忽略无效昵称
                if (newNick && newNick !== '未知' && newNick !== '未登录') {
                    // 避免频繁写入，只在内存中无昵称或不一致时更新
                    if (worker.nick !== newNick) {
                        const oldNick = worker.nick;
                        worker.nick = newNick;
                        addOrUpdateAccount({
                            id: accountId,
                            nick: newNick,
                        });
                        // 仅在首次同步或名称变更时记录日志
                        if (oldNick !== newNick) {
                            log('系统', `已同步账号昵称: ${oldNick || 'None'} -> ${newNick}`, { accountId, accountName: worker.name });
                        }
                    }
                }
            }

            if (!connected && !worker.stopping) {
                const now = Date.now();
                if (!worker.disconnectedSince) worker.disconnectedSince = now;
                const offlineMs = now - worker.disconnectedSince;
                const autoDeleteMs = getOfflineAutoDeleteMs(worker.username);
                if (!worker.autoDeleteTriggered && offlineMs >= autoDeleteMs) {
                    worker.autoDeleteTriggered = true;
                    const offlineMin = Math.floor(offlineMs / 60000);
                    log('系统', `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，自动删除账号信息`);
                    triggerOfflineReminder({
                        accountId,
                        accountName: worker.name,
                        username: worker.username,
                        reason: 'offline_timeout',
                        offlineMs,
                    });
                    addAccountLog(
                        'offline_delete',
                        `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，已自动删除`,
                        accountId,
                        worker.name,
                        { reason: 'offline_timeout', offlineMs },
                    );
                    stopWorker(accountId);
                    try {
                        deleteAccount(accountId);
                    } catch (e) {
                        log('错误', `删除离线账号失败: ${errorMessage(e)}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            // 保存日志
            const logEntry: LogEntry = {
                ...msg.data,
                accountId,
                accountName: worker.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {},
            };
            logEntry._searchText = `${logEntry.msg || ''} ${logEntry.tag || ''} ${JSON.stringify(logEntry.meta || {})}`.toLowerCase();
            worker.logs.push(logEntry);
            if (worker.logs.length > 1000) worker.logs.shift();
            globalLogs.push(logEntry);
            if (globalLogs.length > 1000) globalLogs.shift();
            if (typeof onWorkerLog === 'function') {
                onWorkerLog(logEntry, accountId, worker.name);
            }
        } else if (msg.type === 'error') {
            log('错误', `账号[${accountId}]进程报错: ${msg.error}`, { accountId: String(accountId), accountName: worker.name });
        } else if (msg.type === 'wx_credential_request') {
            const requestId = msg.id;
            const sendCredentialResponse = (payload: { result?: unknown; error?: string }): void => {
                const current = workers[accountId];
                if (!current || current.process !== worker.process) return;
                try {
                    current.process.send({ type: 'wx_credential_response', id: requestId, ...payload });
                } catch {}
            };
            Promise.resolve().then(async () => {
                const accounts = typeof getAccounts === 'function' ? getAccounts() : { accounts: [] };
                const acc = (accounts.accounts || []).find((item: AccountRecord) => String(item.id) === String(accountId));
                if (!acc || !acc.wxid) throw new Error('找不到当前微信账号凭证');

                const { getFarmCode, keepWxCredentialAlive } = require('../services/wx-login-adapter');
                if (msg.action === 'refresh_code') {
                    const refresh = await getFarmCode(acc.wxid, { accountId: acc.id });
                    if (refresh.Success && refresh.Data && refresh.Data.code) {
                        addOrUpdateAccount({ id: acc.id, code: refresh.Data.code });
                    }
                    return refresh;
                }
                if (msg.action === 'keepalive') {
                    const alive = await keepWxCredentialAlive(acc);
                    if (!alive.Success) return alive;
                    const refresh = await getFarmCode(acc.wxid, { accountId: acc.id });
                    if (!refresh.Success || !refresh.Data || !refresh.Data.code) return refresh;
                    addOrUpdateAccount({ id: acc.id, code: refresh.Data.code });
                    return { Success: true, Data: { code: refresh.Data.code } };
                }
                throw new Error('未知微信凭证操作');
            }).then((result) => {
                sendCredentialResponse({ result });
            }).catch((error: unknown) => {
                sendCredentialResponse({ error: errorMessage(error) });
            });
        } else if (msg.type === 'ws_error') {
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            log('系统', `账号 ${worker.name} 网关连接异常，正在自动恢复${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`, {
                accountId: String(accountId),
                accountName: worker.name,
                code,
            });
        } else if (msg.type === 'reauth_required') {
            const code = Number(msg.code) || 400;
            const message = msg.message || '登录凭证已失效';
            worker.wsError = { code, message, at: Date.now() };
            reauthRequiredStates.set(String(accountId), worker.wsError);
            addAccountLog(
                'reauth_required',
                `账号 ${worker.name} 自动恢复失败，请更新登录凭证`,
                accountId,
                worker.name,
                { reason: message },
            );
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, {
                    ...(worker.status || {}),
                    wsError: worker.wsError,
                }, worker.name);
            }
        } else if (msg.type === 'account_kicked') {
            const reason = msg.reason || '未知';
            log('系统', `账号 ${worker.name} 被踢下线，已自动停止账号`, { accountId: String(accountId), accountName: worker.name });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `kickout:${reason}`,
                offlineMs: 0,
            });
            addAccountLog('kickout_stop', `账号 ${worker.name} 被踢下线，已自动停止`, accountId, worker.name, { reason });
            stopWorker(accountId);
            // 自动重登（配置开启时，15 分钟后重新登录，带每日上限与防循环）
            scheduleAutoRelogin(accountId, reason);
        } else if (msg.type === 'version_prefix_update') {
            // 服务端 version_info 校准：worker 上报新版本前缀，持久化跨重启
            const prefix = String(msg.prefix || '').trim();
            if (prefix) {
                const { setVersionPrefix } = require('../models/store');
                setVersionPrefix(prefix);
                log('系统', `服务端版本校准：账号 ${worker.name} 上报新版本前缀 ${prefix}，已持久化`, { accountId: String(accountId), accountName: worker.name });
            }
        } else if (msg.type === 'api_response') {
            const { id, result, error } = msg;
            managerScheduler.clear(`api_timeout_${accountId}_${id}`);
            const req = worker.requests.get(id);
            if (req) {
                if (error) req.reject(new Error(error));
                else req.resolve(result);
                worker.requests.delete(id);
            }
        } else if (msg.type === 'friend_blacklist_add') {
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist: addToBlacklist } = require('../models/store');
                addToBlacklist(accountId, gid);
                log('好友', `已将好友 ${msg.friendName || `GID:${gid}`} 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason,
                });
                // 同步配置到 worker 进程
                const worker_process = workers[accountId];
                if (worker_process && worker_process.process) {
                    worker_process.process.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(accountId) });
                }
            }
        } else if (msg.type === 'pong' || msg.type === 'stat_update') {
            void msg;
        } else {
            assertNever(msg);
        }
    }

    const ACTIVITY_READ_METHODS = new Set([
        'getActivityCenterSnapshot',
        'getCurrentSeasonEvent',
        'getCurrentStarSandShop',
        'getCurrentSolarTerms',
        'getCurrentQingMeiActivity',
    ]);
    const ACTIVITY_MUTATION_METHODS = new Set([
        'claimBattlePassRewards',
        'exchangeStarSandGoods',
        'lightConstellation',
        'claimSolarTerm',
        'claimQingMeiDailySeed',
        'startQingMeiBrew',
        'continueQingMeiBrew',
        'settleQingMeiBrew',
    ]);

    function workerApiTimeout(method: string): number {
        // 活动变更包含操作前校验、实际写操作与操作后快照，可能串行执行多次游戏请求。
        if (ACTIVITY_MUTATION_METHODS.has(method)) return 150000;
        if (ACTIVITY_READ_METHODS.has(method)) return 25000;
        return 10000;
    }

    function callWorkerApi(accountId: AccountId, method: string, ...args: unknown[]): Promise<unknown> {
        const worker = workers[accountId];
        if (!worker) return Promise.reject(new Error('账号未运行'));

        return new Promise<unknown>((resolve, reject) => {
            const id = worker.reqId++;
            worker.requests.set(id, { resolve, reject });

            // 超时处理
            managerScheduler.setTimeoutTask(`api_timeout_${accountId}_${id}`, workerApiTimeout(method), () => {
                if (worker.requests.has(id)) {
                    worker.requests.delete(id);
                    reject(new Error('API Timeout'));
                }
            });

            worker.process.send({ type: 'api_call', id, method, args });
        });
    }

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        resetAutoReloginState,
    };
}

export { createWorkerManager };
