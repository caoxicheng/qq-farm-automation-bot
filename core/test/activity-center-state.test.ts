import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    loadConstellationState,
    mergeConstellationStates,
    normalizeConstellationState,
    persistConstellationState,
    safeAccountFileToken,
    stateFromDynamicNodes,
    stateWithNoClaimableDay,
} from '../src/services/activity-center-state';

const test = require('node:test') as typeof import('node:test');

const identity = { seasonId: '202608', activityId: '13', catalogVersion: 2 };

test('星座状态只合并同一目录版本并保持节点集合有序', () => {
    const stale = normalizeConstellationState({
        ...identity,
        catalogVersion: 1,
        confirmedOpenedNodeIds: ['99'],
    }, identity);
    assert.deepEqual(stale.confirmedOpenedNodeIds, []);

    const merged = mergeConstellationStates(
        identity,
        { ...identity, confirmedOpenedNodeIds: ['10', '2'], confirmedLitNodeIds: [], noClaimableDays: {} },
        { ...identity, confirmedOpenedNodeIds: [], confirmedLitNodeIds: ['2', '3'], noClaimableDays: {} },
    );
    assert.deepEqual(merged.confirmedOpenedNodeIds, ['2', '3', '10']);
    assert.deepEqual(merged.confirmedLitNodeIds, ['2', '3']);
});

test('动态节点和无可领取日状态可以原子持久化并按账号隔离', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-activity-state-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const firstFile = path.join(root, `${safeAccountFileToken('account-a')}.json`);
    const secondFile = path.join(root, `${safeAccountFileToken('account-b')}.json`);

    const dynamic = stateFromDynamicNodes(identity, [
        { node_id: '8', field_2: true },
        { node_id: '9', field_3: true },
    ]);
    const observed = stateWithNoClaimableDay(identity, 3, '1720000000', '2026-08-14T00:00:00.000Z');
    persistConstellationState(dynamic, identity, 'account-a', { filePath: firstFile });
    persistConstellationState(observed, identity, 'account-a', { filePath: firstFile });

    const loaded = loadConstellationState(identity, 'account-a', { filePath: firstFile });
    assert.deepEqual(loaded.confirmedOpenedNodeIds, ['8', '9']);
    assert.deepEqual(loaded.confirmedLitNodeIds, ['9']);
    assert.deepEqual(loaded.noClaimableDays['3'], {
        observedAt: '2026-08-14T00:00:00.000Z',
        serverTime: '1720000000',
    });
    assert.deepEqual(
        loadConstellationState(identity, 'account-b', { filePath: secondFile }).confirmedOpenedNodeIds,
        [],
    );
});
