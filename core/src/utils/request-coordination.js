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

module.exports = { canReserveRequest, createSingleFlight };
