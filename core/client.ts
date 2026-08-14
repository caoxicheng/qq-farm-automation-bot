import process from 'node:process';
import {
    emitRealtimeAccountLog,
    emitRealtimeLog,
    emitRealtimeStatus,
    startAdminServer,
} from './src/controllers/admin';
import { createRuntimeEngine } from './src/runtime/runtime-engine';
import { createModuleLogger } from './src/services/logger';
import { versionChecker } from './src/services/version-checker';

/**
 * 主程序 - 进程管理器
 * 负责启动 Web 面板，并管理多个 Bot 子进程
 */

const mainLogger = createModuleLogger('main');

// 打包后 worker 由当前可执行文件以 --worker 模式启动
const isWorkerProcess = process.env.FARM_WORKER === '1';
if (isWorkerProcess) {
    require('./src/core/worker');
} else {
    versionChecker.start();
    const runtimeEngine = createRuntimeEngine({
        processRef: process,
        mainEntryPath: __filename,
        startAdminServer,
        onStatusSync: (accountId, status) => {
            emitRealtimeStatus(accountId, status);
        },
        onLog: (entry, accountId) => {
            // 确保日志条目包含 accountId
            if (accountId && entry) {
                entry.accountId = accountId;
            }
            emitRealtimeLog(entry);
        },
        onAccountLog: (entry) => {
            emitRealtimeAccountLog(entry);
        },
    });

    runtimeEngine.start({
        startAdminServer: true,
        autoStartAccounts: false,
    }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        mainLogger.error('runtime bootstrap failed', { error: message });
    });
}
