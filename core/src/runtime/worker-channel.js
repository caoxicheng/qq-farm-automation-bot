function sendWorkerMessage(processRef, parentPort, payload) {
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

function flushWorkerMessage(processRef, parentPort, payload, timeoutMs = 1000) {
    if (processRef && typeof processRef.send === 'function') {
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(finish, Math.max(1, Number(timeoutMs) || 1000));
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

module.exports = {
    flushWorkerMessage,
    sendWorkerMessage,
};
