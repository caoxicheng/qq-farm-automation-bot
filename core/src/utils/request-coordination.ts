export type RequestCategory = 'control' | 'business';

export interface PendingRequestEntry {
    category?: string;
}

export interface RequestLimits {
    maxPending?: number;
    maxBusiness?: number;
}

export interface SnapshotRecord {
    errors?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface CoalescedBackgroundTask {
    trigger: () => void;
    cancel: () => void;
}

export interface CoalescedBackgroundTaskOptions {
    delayMs?: number;
    onError?: (error: unknown) => void;
}

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    if (error === undefined || error === null || error === '') return fallback;
    return String(error);
}

export function canReserveRequest(
    entries: Iterable<PendingRequestEntry | null | undefined> | null | undefined,
    category: RequestCategory | string,
    limits: RequestLimits = {},
): boolean {
    const list = Array.from(entries || []);
    const maxPending = Math.max(1, Number(limits.maxPending) || 5);
    const maxBusiness = Math.max(1, Number(limits.maxBusiness) || 4);
    if (list.length >= maxPending) return false;
    if (category === 'control') return true;
    return list.filter(entry => entry && entry.category !== 'control').length < maxBusiness;
}

export function createSingleFlight<Args extends unknown[], Result>(
    operation: (...args: Args) => Result | PromiseLike<Result>,
): (...args: Args) => Promise<Result> {
    let inFlight: Promise<Result> | null = null;
    return function run(...args: Args): Promise<Result> {
        if (inFlight) return inFlight;
        let request: Promise<Result>;
        try {
            request = Promise.resolve(operation(...args));
        } catch (error) {
            request = Promise.reject(error);
        }
        const tracked = request.finally(() => {
            if (inFlight === tracked) inFlight = null;
        });
        inFlight = tracked;
        return tracked;
    };
}

export function createCoalescedBackgroundTask(
    operation: () => unknown | PromiseLike<unknown>,
    options: CoalescedBackgroundTaskOptions = {},
): CoalescedBackgroundTask {
    const delayMs = Math.max(0, Math.floor(Number(options.delayMs) || 0));
    let timer: NodeJS.Timeout | null = null;
    let running = false;
    let pending = false;
    let cancelled = false;

    function schedule(): void {
        if (cancelled || running) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void run();
        }, delayMs);
    }

    async function run(): Promise<void> {
        if (cancelled || running || !pending) return;
        pending = false;
        running = true;
        try {
            await operation();
        } catch (error) {
            options.onError?.(error);
        } finally {
            running = false;
            if (pending && !cancelled) schedule();
        }
    }

    return {
        trigger(): void {
            if (cancelled) return;
            pending = true;
            schedule();
        },
        cancel(): void {
            cancelled = true;
            pending = false;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        },
    };
}

export async function retryFailedSnapshotSection<T extends SnapshotRecord>(
    snapshot: T | null | undefined,
    section: string,
    loader: () => unknown | PromiseLike<unknown>,
): Promise<T | null | undefined> {
    if (!snapshot || snapshot[section] || !snapshot.errors?.[section]) return snapshot;
    try {
        const value = await loader();
        if (value == null) throw new Error(`${section} 补读未返回数据`);
        return {
            ...snapshot,
            [section]: value,
            errors: { ...snapshot.errors, [section]: null },
        };
    } catch (error) {
        const retryError = errorMessage(error, '未知错误');
        return {
            ...snapshot,
            errors: { ...snapshot.errors, [section]: `${snapshot.errors[section]}; 补读失败: ${retryError}` },
        };
    }
}

export async function capturePostMutationSnapshot<T>(
    loader: () => T | PromiseLike<T>,
): Promise<{ snapshot: T; snapshotError: null } | { snapshot: null; snapshotError: string }> {
    try {
        return { snapshot: await loader(), snapshotError: null };
    } catch (error) {
        return {
            snapshot: null,
            snapshotError: errorMessage(error, '操作后状态刷新失败'),
        };
    }
}
