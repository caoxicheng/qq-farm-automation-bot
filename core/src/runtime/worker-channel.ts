import type { WorkerChannelMessage } from '../types/ipc';

export interface ProcessMessageChannel {
    send: (payload: WorkerChannelMessage, callback?: () => void) => unknown;
}

export interface ThreadMessageChannel {
    postMessage: (payload: WorkerChannelMessage) => void;
}

export function sendWorkerMessage(
    processRef: ProcessMessageChannel | null | undefined,
    parentPort: ThreadMessageChannel | null | undefined,
    payload: WorkerChannelMessage,
): boolean {
    if (processRef && typeof processRef.send === 'function') {
        processRef.send(payload);
        return true;
    }
    if (parentPort && typeof parentPort.postMessage === 'function') {
        parentPort.postMessage(payload);
        return true;
    }
    return false;
}

export function flushWorkerMessage(
    processRef: ProcessMessageChannel | null | undefined,
    parentPort: ThreadMessageChannel | null | undefined,
    payload: WorkerChannelMessage,
    timeoutMs = 1000,
): Promise<void> {
    if (processRef && typeof processRef.send === 'function') {
        return new Promise((resolve) => {
            let settled = false;
            let timer: NodeJS.Timeout;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            timer = setTimeout(finish, Math.max(1, Number(timeoutMs) || 1000));
            try {
                processRef.send(payload, finish);
            } catch {
                finish();
            }
        });
    }

    if (parentPort && typeof parentPort.postMessage === 'function') {
        try {
            parentPort.postMessage(payload);
        } catch {
            return Promise.resolve();
        }
        return new Promise(resolve => setImmediate(resolve));
    }

    return Promise.resolve();
}
