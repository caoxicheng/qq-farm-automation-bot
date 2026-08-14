import { fork } from 'node:child_process'
import EventEmitter from 'node:events'
import path from 'node:path'
import process from 'node:process'
import { Worker } from 'node:worker_threads'
import type { DataProvider } from './data-provider'
import type { AccountId, AccountRecord, LogEntry, WorkerRecord } from '../types/domain'
import { createDataProvider } from './data-provider'
import { createReloginReminderService } from './relogin-reminder'
import { createRuntimeState } from './runtime-state'
import { createWorkerManager } from './worker-manager'
const store = require('../models/store')
const { updateRuntimeConfig, setClientVersionPrefix } = require('../config/config')
const { sendPushooMessage } = require('../services/push')
const { MiniProgramLoginSession } = require('../services/qrlogin')

type DynamicRecord = Record<string, any>

interface ProcessReference {
  pkg?: unknown
  execPath: string
  env: NodeJS.ProcessEnv
}

interface RuntimeEngineOptions {
  processRef?: ProcessReference
  mainEntryPath?: string
  workerScriptPath?: string
  runtimeMode?: string
  onStatusSync?: (accountId: AccountId, status: unknown, accountName: string) => void
  onLog?: (entry: LogEntry, accountId: AccountId | '', accountName: string) => void
  onAccountLog?: (entry: DynamicRecord) => void
  startAdminServer?: (provider: DataProvider) => unknown
}

interface RuntimeStartOptions {
  startAdminServer?: boolean
  autoStartAccounts?: boolean
}

interface WorkerControls {
  startWorker?: (account: AccountRecord) => unknown
  restartWorker?: (account: AccountRecord) => unknown
}

export interface RuntimeEngine {
  store: DynamicRecord
  runtimeEvents: EventEmitter
  workers: Record<string, WorkerRecord>
  dataProvider: DataProvider
  start: (options?: RuntimeStartOptions) => Promise<void>
  startAllAccounts: () => void
  stopAllAccounts: () => void
  broadcastConfigToWorkers: (targetAccountId?: AccountId | '') => void
  startWorker: (account: AccountRecord) => boolean
  stopWorker: (accountId: AccountId) => void
  restartWorker: (account: AccountRecord) => boolean | void
  callWorkerApi: (accountId: AccountId, method: string, ...args: unknown[]) => Promise<unknown>
  log: (tag: string, message: string, extra?: DynamicRecord) => void
  addAccountLog: (...args: any[]) => void
}

const OPERATION_KEYS = ['harvest', 'water', 'weed', 'bug', 'fertilize', 'plant', 'steal', 'helpWater', 'helpWeed', 'helpBug', 'taskClaim', 'sell', 'upgrade']

function createRuntimeEngine(options: RuntimeEngineOptions = {}): RuntimeEngine {
  const processRef = options.processRef || process as ProcessReference
  const mainEntryPath = options.mainEntryPath || path.join(__dirname, '../../client.js')

  // 启动时恢复服务端校准过的版本前缀（跨重启持久化），供 worker 进程继承
  if (typeof store.getVersionPrefix === 'function') {
    const savedPrefix = store.getVersionPrefix()
    if (savedPrefix) setClientVersionPrefix(savedPrefix)
  }
  const workerScriptPath = options.workerScriptPath || path.join(__dirname, '../core/worker.js')
  const runtimeMode = String(options.runtimeMode || processRef.env.FARM_RUNTIME_MODE || 'thread').toLowerCase()
  const onStatusSync = typeof options.onStatusSync === 'function' ? options.onStatusSync : null
  const onLog = typeof options.onLog === 'function' ? options.onLog : null
  const onAccountLog = typeof options.onAccountLog === 'function' ? options.onAccountLog : null
  const startAdminServer = typeof options.startAdminServer === 'function' ? options.startAdminServer : null

  const workerControls: WorkerControls = {}
  const reauthRequiredStates = new Map<string, { code: number, message: string, at: number }>()
  const runtimeState = createRuntimeState({
    store,
    operationKeys: OPERATION_KEYS,
  })
  const {
    workers,
    globalLogs: GLOBAL_LOGS,
    accountLogs: ACCOUNT_LOGS,
    runtimeEvents,
    nextConfigRevision,
    buildConfigSnapshotForAccount,
    log,
    addAccountLog,
    normalizeStatusForPanel,
    buildDefaultStatus,
    filterLogs,
  } = runtimeState

  const reloginReminder = createReloginReminderService({
    store,
    miniProgramLoginSession: MiniProgramLoginSession,
    sendPushooMessage,
    log,
    addAccountLog,
    getAccounts: store.getAccounts,
    addOrUpdateAccount: store.addOrUpdateAccount,
    resolveWorkerControls: () => workerControls,
  })

  const {
    getOfflineAutoDeleteMs,
    triggerOfflineReminder,
  } = reloginReminder

  const { startWorker, stopWorker, restartWorker, callWorkerApi, resetAutoReloginState } = createWorkerManager({
    fork: fork as any,
    WorkerThread: Worker as any,
    runtimeMode,
    processRef,
    mainEntryPath,
    workerScriptPath,
    workers,
    globalLogs: GLOBAL_LOGS,
    log,
    addAccountLog,
    normalizeStatusForPanel,
    buildConfigSnapshotForAccount,
    getOfflineAutoDeleteMs,
    triggerOfflineReminder,
    addOrUpdateAccount: store.addOrUpdateAccount,
    deleteAccount: store.deleteAccount,
    getAutoRelogin: store.getAutoRelogin,
    getAccounts: store.getAccounts,
    reauthRequiredStates,
    onStatusSync: (accountId: AccountId, status: unknown, accountName: string) => {
      runtimeEvents.emit('status', { accountId, status, accountName })
      if (onStatusSync) onStatusSync(accountId, status, accountName)
    },
    onWorkerLog: (entry: LogEntry, accountId: AccountId, accountName: string) => {
      runtimeEvents.emit('worker_log', { entry, accountId, accountName })
      if (onLog) onLog(entry, accountId, accountName)
    },
  })
  workerControls.startWorker = startWorker
  workerControls.restartWorker = restartWorker

  const dataProvider = createDataProvider({
    workers,
    globalLogs: GLOBAL_LOGS,
    accountLogs: ACCOUNT_LOGS,
    reauthRequiredStates,
    store,
    getAccounts: store.getAccounts,
    callWorkerApi,
    buildDefaultStatus,
    normalizeStatusForPanel,
    filterLogs,
    addAccountLog,
    nextConfigRevision,
    broadcastConfigToWorkers,
    startWorker,
    stopWorker,
    restartWorker,
    resetAutoReloginState,
  })

  runtimeEvents.on('log', (entry: LogEntry) => {
    if (onLog) onLog(entry, entry && entry.accountId ? entry.accountId : '', entry && entry.accountName ? entry.accountName : '')
  })
  runtimeEvents.on('account_log', (entry: DynamicRecord) => {
    if (onAccountLog) onAccountLog(entry)
  })

  function broadcastConfigToWorkers(targetAccountId: AccountId | '' = ''): void {
    const targetId = String(targetAccountId || '').trim()
    for (const [accId, worker] of Object.entries(workers)) {
      if (targetId && String(accId) !== targetId) continue
      const snapshot = buildConfigSnapshotForAccount(accId)
      try {
        worker.process.send({ type: 'config_sync', config: snapshot })
      }
      catch {
        // ignore IPC failures for exited workers
      }
    }
  }

  function startAllAccounts(): void {
    const accounts = (store.getAccounts().accounts || [])
    if (accounts.length > 0) {
      log('系统', `发现 ${accounts.length} 个账号，正在启动...`)
      accounts.forEach((account: AccountRecord) => startWorker(account))
    }
    else {
      log('系统', '未发现账号，请访问管理面板添加账号')
    }
  }

  async function start(options: RuntimeStartOptions = {}): Promise<void> {
    const shouldStartAdminServer = options.startAdminServer !== false
    const shouldAutoStartAccounts = options.autoStartAccounts !== false

    // 启动时加载已保存的系统配置
    const savedSystemConfig = store.getSystemConfig()
    if (savedSystemConfig) {
      updateRuntimeConfig(savedSystemConfig)
      log('系统', `已加载系统配置: serverUrl=${savedSystemConfig.serverUrl}, clientVersion=${savedSystemConfig.clientVersion}, platform=${savedSystemConfig.platform}`)
    }

    if (shouldStartAdminServer && startAdminServer) {
      startAdminServer(dataProvider)
    }

    if (shouldAutoStartAccounts) {
      startAllAccounts()
    }
  }

  function stopAllAccounts(): void {
    for (const accountId of Object.keys(workers)) {
      stopWorker(accountId)
    }
  }

  return {
    store,
    runtimeEvents,
    workers,
    dataProvider,
    start,
    startAllAccounts,
    stopAllAccounts,
    broadcastConfigToWorkers,
    startWorker,
    stopWorker,
    restartWorker,
    callWorkerApi,
    log,
    addAccountLog,
  }
}

export { createRuntimeEngine }
