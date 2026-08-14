const assert = require('node:assert/strict');
const test = require('node:test');
const { createScheduler } = require('../src/services/scheduler');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('同名 timeout 会替换旧任务并在执行后移出快照', async (t) => {
    const scheduler = createScheduler(`test_replace_${Date.now()}`);
    t.after(() => scheduler.clearAll());
    const calls = [];

    scheduler.setTimeoutTask('sync', 30, () => calls.push('old'));
    scheduler.setTimeoutTask('sync', 5, () => calls.push('new'));
    await delay(60);

    assert.deepEqual(calls, ['new']);
    assert.equal(scheduler.has('sync'), false);
    assert.equal(scheduler.getSnapshot().taskCount, 0);
});

test('clear 会取消任务且重复清理安全返回 false', async (t) => {
    const scheduler = createScheduler(`test_clear_${Date.now()}`);
    t.after(() => scheduler.clearAll());
    let called = false;

    scheduler.setTimeoutTask('pending', 10, () => { called = true; });
    assert.equal(scheduler.clear('pending'), true);
    assert.equal(scheduler.clear('pending'), false);
    await delay(30);

    assert.equal(called, false);
});

test('立即执行的 interval 默认防止异步任务重入并暴露运行快照', async (t) => {
    const scheduler = createScheduler(`test_overlap_${Date.now()}`);
    let release;
    const blocker = new Promise((resolve) => { release = resolve; });
    let runs = 0;
    t.after(() => {
        scheduler.clearAll();
        release();
    });

    scheduler.setIntervalTask('poll', 5, async () => {
        runs += 1;
        await blocker;
    }, { runImmediately: true });

    await delay(25);
    const snapshot = scheduler.getSnapshot();
    assert.equal(runs, 1);
    assert.equal(snapshot.taskCount, 1);
    assert.equal(snapshot.tasks[0].running, true);
    assert.equal(snapshot.tasks[0].preventOverlap, true);

    scheduler.clear('poll');
    release();
});
export {};
