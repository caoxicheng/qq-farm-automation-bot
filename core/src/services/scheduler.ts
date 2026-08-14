const { createModuleLogger } = require('./logger');

type TaskKind = 'timeout' | 'interval';
type TaskCallback = () => unknown | PromiseLike<unknown>;

export interface IntervalTaskOptions {
    preventOverlap?: boolean;
    runImmediately?: boolean;
}

export interface SchedulerTaskSnapshot {
    name: string;
    kind: TaskKind;
    delayMs: number;
    createdAt: number;
    nextRunAt: number;
    lastRunAt: number;
    runCount: number;
    running: boolean;
    preventOverlap: boolean;
}

export interface SchedulerNamespaceSnapshot {
    namespace: string;
    createdAt: number;
    taskCount: number;
    tasks: SchedulerTaskSnapshot[];
}

export interface SchedulerRegistrySnapshot {
    generatedAt: number;
    schedulerCount: number;
    schedulers: SchedulerNamespaceSnapshot[];
}

export interface Scheduler {
    setTimeoutTask: (taskName: string, delayMs: unknown, taskFn: TaskCallback) => NodeJS.Timeout;
    setIntervalTask: (
        taskName: string,
        intervalMs: unknown,
        taskFn: TaskCallback,
        options?: IntervalTaskOptions,
    ) => NodeJS.Timeout;
    clear: (taskName: string) => boolean;
    clearAll: () => void;
    has: (taskName: string) => boolean;
    getTaskNames: () => string[];
    getSnapshot: () => SchedulerNamespaceSnapshot;
}

interface SchedulerTaskMeta {
    kind: TaskKind;
    delayMs: number;
    createdAt: number;
    nextRunAt: number;
    lastRunAt: number;
    runCount: number;
    running: boolean;
    preventOverlap: boolean;
    handle: NodeJS.Timeout | null;
}

interface SchedulerNamespaceStore {
    namespace: string;
    createdAt: number;
    timers: Map<string, SchedulerTaskMeta>;
}

const schedulerLogger = createModuleLogger('scheduler');
const schedulerRegistry = new Map<string, SchedulerNamespaceStore>();

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function toDelayMs(value: unknown, fallbackMs = 0): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return Math.max(0, fallbackMs | 0);
    return Math.max(0, Math.floor(n));
}

function ensureNamespaceStore(namespace: unknown): SchedulerNamespaceStore {
    const key = String(namespace || 'default');
    const existed = schedulerRegistry.get(key);
    if (existed) return existed;
    const created: SchedulerNamespaceStore = {
        namespace: key,
        createdAt: Date.now(),
        timers: new Map(),
    };
    schedulerRegistry.set(key, created);
    return created;
}

function normalizeTaskSnapshot(taskName: unknown, meta: SchedulerTaskMeta): SchedulerTaskSnapshot {
    return {
        name: String(taskName || ''),
        kind: meta.kind || 'timeout',
        delayMs: Math.max(0, Number(meta.delayMs) || 0),
        createdAt: Number(meta.createdAt) || 0,
        nextRunAt: Number(meta.nextRunAt) || 0,
        lastRunAt: Number(meta.lastRunAt) || 0,
        runCount: Number(meta.runCount) || 0,
        running: !!meta.running,
        preventOverlap: meta.preventOverlap !== false,
    };
}

export function getSchedulerRegistrySnapshot(namespace = ''): SchedulerRegistrySnapshot {
    const selectedNamespace = String(namespace || '').trim();
    const list: SchedulerNamespaceSnapshot[] = [];
    for (const [name, store] of schedulerRegistry.entries()) {
        if (selectedNamespace && name !== selectedNamespace) continue;
        const tasks: SchedulerTaskSnapshot[] = [];
        for (const [taskName, meta] of store.timers.entries()) {
            tasks.push(normalizeTaskSnapshot(taskName, meta));
        }
        tasks.sort((a, b) => a.name.localeCompare(b.name));
        list.push({
            namespace: name,
            createdAt: Number(store.createdAt) || 0,
            taskCount: tasks.length,
            tasks,
        });
    }
    list.sort((a, b) => a.namespace.localeCompare(b.namespace));
    return {
        generatedAt: Date.now(),
        schedulerCount: list.length,
        schedulers: list,
    };
}

export function createScheduler(namespace = 'default'): Scheduler {
    const name = String(namespace || 'default');
    const store = ensureNamespaceStore(name);
    const timers = store.timers;

    function clear(taskName: string): boolean {
        const key = String(taskName || '');
        const entry = timers.get(key);
        if (!entry) return false;
        timers.delete(key);
        if (entry.handle) {
            if (entry.kind === 'interval') {
                clearInterval(entry.handle);
            } else {
                clearTimeout(entry.handle);
            }
        }
        return true;
    }

    function clearAll(): void {
        const keys = Array.from(timers.keys());
        for (const key of keys) clear(key);
    }

    function setTimeoutTask(taskName: string, delayMs: unknown, taskFn: TaskCallback): NodeJS.Timeout {
        const key = String(taskName || '');
        if (!key) throw new Error('taskName 不能为空');
        if (typeof taskFn !== 'function') throw new Error(`timeout 任务 ${key} 缺少回调函数`);
        clear(key);
        const delay = toDelayMs(delayMs, 0);
        const entry: SchedulerTaskMeta = {
            kind: 'timeout',
            delayMs: delay,
            createdAt: Date.now(),
            nextRunAt: Date.now() + delay,
            lastRunAt: 0,
            runCount: 0,
            running: false,
            preventOverlap: true,
            handle: null,
        };
        const handle = setTimeout(async () => {
            const current = timers.get(key);
            if (!current || current.handle !== handle) return;
            current.running = true;
            current.lastRunAt = Date.now();
            current.runCount += 1;
            try {
                await taskFn();
            } catch (error) {
                schedulerLogger.warn(`[${name}] timeout 任务执行失败: ${key}`, {
                    module: 'scheduler',
                    scope: name,
                    task: key,
                    error: errorMessage(error),
                });
            } finally {
                // 只删除自己，避免删掉 taskFn 执行期间注册的新 entry
                const after = timers.get(key);
                if (after && after.handle === handle) {
                    timers.delete(key);
                }
            }
        }, delay);
        entry.handle = handle;
        timers.set(key, entry);
        return handle;
    }

    function setIntervalTask(
        taskName: string,
        intervalMs: unknown,
        taskFn: TaskCallback,
        options: IntervalTaskOptions = {},
    ): NodeJS.Timeout {
        const key = String(taskName || '');
        if (!key) throw new Error('taskName 不能为空');
        if (typeof taskFn !== 'function') throw new Error(`interval 任务 ${key} 缺少回调函数`);
        clear(key);

        const delay = Math.max(1, toDelayMs(intervalMs, 1000));
        const preventOverlap = options.preventOverlap !== false;
        const runImmediately = !!options.runImmediately;
        const entry: SchedulerTaskMeta = {
            kind: 'interval',
            delayMs: delay,
            createdAt: Date.now(),
            nextRunAt: Date.now() + delay,
            lastRunAt: 0,
            runCount: 0,
            running: false,
            preventOverlap,
            handle: null,
        };

        const runner = async () => {
            const current = timers.get(key);
            if (!current) return;
            if (preventOverlap && current.running) return;
            current.running = true;
            current.lastRunAt = Date.now();
            current.runCount += 1;
            try {
                await taskFn();
            } catch (error) {
                schedulerLogger.warn(`[${name}] interval 任务执行失败: ${key}`, {
                    module: 'scheduler',
                    scope: name,
                    task: key,
                    error: errorMessage(error),
                });
            } finally {
                const updated = timers.get(key);
                if (updated) {
                    updated.running = false;
                    updated.nextRunAt = Date.now() + delay;
                }
            }
        };

        if (runImmediately) {
            Promise.resolve().then(runner).catch(() => undefined);
        }

        const handle = setInterval(runner, delay);
        entry.handle = handle;
        timers.set(key, entry);
        return handle;
    }

    function has(taskName: string): boolean {
        return timers.has(String(taskName || ''));
    }

    function getTaskNames(): string[] {
        return Array.from(timers.keys());
    }

    function getSnapshot(): SchedulerNamespaceSnapshot {
        const registrySnapshot = getSchedulerRegistrySnapshot(name);
        return registrySnapshot.schedulers[0] || {
            namespace: name,
            createdAt: Date.now(),
            taskCount: 0,
            tasks: [],
        };
    }

    return {
        setTimeoutTask,
        setIntervalTask,
        clear,
        clearAll,
        has,
        getTaskNames,
        getSnapshot,
    };
}
