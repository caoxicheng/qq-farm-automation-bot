import assert from 'node:assert/strict';
import { createActivitySnapshotCoordinator } from '../src/services/activity-snapshot';

const test = require('node:test') as typeof import('node:test');

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

test('活动快照并发读取复用同一个在途请求', async () => {
    const pending = deferred<{ version: number }>();
    let calls = 0;
    const coordinator = createActivitySnapshotCoordinator(async () => {
        calls += 1;
        return pending.promise;
    });

    const first = coordinator.getSnapshot();
    const second = coordinator.getSnapshot();
    pending.resolve({ version: 1 });

    assert.deepEqual(await Promise.all([first, second]), [{ version: 1 }, { version: 1 }]);
    assert.equal(calls, 1);
});

test('强制刷新等待旧快照结束后发起新请求', async () => {
    const firstPending = deferred<number>();
    const secondPending = deferred<number>();
    let calls = 0;
    const coordinator = createActivitySnapshotCoordinator(async () => {
        calls += 1;
        return calls === 1 ? firstPending.promise : secondPending.promise;
    });

    const first = coordinator.getSnapshot();
    await Promise.resolve();
    const fresh = coordinator.getFreshSnapshot();
    await Promise.resolve();
    assert.equal(calls, 1);

    firstPending.resolve(1);
    assert.equal(await first, 1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    secondPending.resolve(2);
    assert.equal(await fresh, 2);
});

test('活动写操作等待快照并按提交顺序串行执行', async () => {
    const snapshotPending = deferred<string>();
    const firstMutation = deferred<void>();
    const events: string[] = [];
    const coordinator = createActivitySnapshotCoordinator(async () => snapshotPending.promise);

    const snapshot = coordinator.getSnapshot();
    const first = coordinator.serializeMutation(async () => {
        events.push('first:start');
        await firstMutation.promise;
        events.push('first:end');
    });
    const second = coordinator.serializeMutation(async () => {
        events.push('second');
    });

    await Promise.resolve();
    assert.deepEqual(events, []);
    snapshotPending.resolve('ready');
    await snapshot;
    await Promise.resolve();
    assert.deepEqual(events, ['first:start']);
    firstMutation.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first:start', 'first:end', 'second']);
});
