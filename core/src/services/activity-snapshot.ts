import { createSingleFlight } from '../utils/request-coordination';

export interface ActivitySnapshotCoordinator<TOverride, TSnapshot> {
    getSnapshot: (override?: TOverride | null) => Promise<TSnapshot>;
    getFreshSnapshot: (override?: TOverride | null) => Promise<TSnapshot>;
    serializeMutation: <T>(operation: () => Promise<T>) => Promise<T>;
}

export function createActivitySnapshotCoordinator<TOverride, TSnapshot>(
    buildSnapshot: (override?: TOverride | null) => Promise<TSnapshot>,
): ActivitySnapshotCoordinator<TOverride, TSnapshot> {
    let mutationTail = Promise.resolve<void>(undefined);
    let snapshotInFlight: Promise<TSnapshot> | null = null;
    const runSnapshotSingleFlight = createSingleFlight(buildSnapshot);

    function getSnapshotSingleFlight(override: TOverride | null = null): Promise<TSnapshot> {
        const request = runSnapshotSingleFlight(override);
        snapshotInFlight = request;
        request.finally(() => {
            if (snapshotInFlight === request) snapshotInFlight = null;
        }).catch(() => undefined);
        return request;
    }

    function getSnapshot(override: TOverride | null = null): Promise<TSnapshot> {
        return mutationTail.then(() => getSnapshotSingleFlight(override));
    }

    async function getFreshSnapshot(override: TOverride | null = null): Promise<TSnapshot> {
        const current = snapshotInFlight;
        if (current) await current.catch(() => undefined);
        return getSnapshotSingleFlight(override);
    }

    function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
        const run = async () => {
            const currentSnapshot = snapshotInFlight;
            if (currentSnapshot) await currentSnapshot.catch(() => undefined);
            return operation();
        };
        const result = mutationTail.then(run, run);
        mutationTail = result.then(() => undefined, () => undefined);
        return result;
    }

    return { getFreshSnapshot, getSnapshot, serializeMutation };
}
