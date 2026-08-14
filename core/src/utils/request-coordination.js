function canReserveRequest(entries, category, limits = {}) {
    const list = Array.from(entries || []);
    const maxPending = Math.max(1, Number(limits.maxPending) || 5);
    const maxBusiness = Math.max(1, Number(limits.maxBusiness) || 4);
    if (list.length >= maxPending) return false;
    if (category === 'control') return true;
    return list.filter(entry => entry && entry.category !== 'control').length < maxBusiness;
}

function createSingleFlight(operation) {
    let inFlight = null;
    return function run(...args) {
        if (inFlight) return inFlight;
        let request;
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

async function retryFailedSnapshotSection(snapshot, section, loader) {
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
        const retryError = String(error?.message || error || '未知错误');
        return {
            ...snapshot,
            errors: { ...snapshot.errors, [section]: `${snapshot.errors[section]}; 补读失败: ${retryError}` },
        };
    }
}

async function capturePostMutationSnapshot(loader) {
    try {
        return { snapshot: await loader(), snapshotError: null };
    } catch (error) {
        return {
            snapshot: null,
            snapshotError: String(error?.message || error || '操作后状态刷新失败'),
        };
    }
}

module.exports = {
    canReserveRequest,
    capturePostMutationSnapshot,
    createSingleFlight,
    retryFailedSnapshotSection,
};
