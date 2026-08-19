import type {
  ActivityActionDto,
  ActivityCenterSnapshotDto,
  ActivityMutationKey,
  ActivityRecord,
  ActivityTabKey,
  QingMeiActivityDto,
} from '@/features/activity-center/types'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchActivitySnapshot, postActivityMutation } from '@/features/activity-center/api'
import {
  errorMessage,
  first,
  normalizeActivitySnapshot,
  normalizeItem,
  record,
  records,
  text,
} from '@/features/activity-center/normalize'

export type * from '@/features/activity-center/types'
export const useActivityCenterStore = defineStore('activity-center', () => {
  const snapshot = ref<ActivityCenterSnapshotDto>(normalizeActivitySnapshot({}))
  const loading = ref(false)
  const error = ref('')
  const actionError = ref('')
  const notice = ref('')
  const loadedAccountId = ref('')
  const successfulAccountId = ref('')
  const serverClockOffset = ref(0)
  const requestVersion = ref(0)
  const pendingActions = ref<Record<ActivityMutationKey, boolean>>({
    claimPass: false,
    lightConstellation: false,
    claimSolar: false,
    exchange: false,
    qingMeiSeed: false,
    qingMeiStart: false,
    qingMeiContinue: false,
    qingMeiSettle: false,
  })
  let loadInFlight: { accountId: string, promise: Promise<boolean> } | null = null

  const season = computed(() => snapshot.value.season)
  const shop = computed(() => snapshot.value.shop)
  const solarTerms = computed(() => snapshot.value.solarTerms)
  const solar = solarTerms
  const constellation = computed(() => snapshot.value.constellation)
  const qingMei = computed(() => snapshot.value.qingMei)
  const actions = computed(() => snapshot.value.actions)
  const serverNow = computed(() => Date.now() + serverClockOffset.value)
  const tabBadges = computed<Partial<Record<ActivityTabKey, boolean>>>(() => ({
    travel: actions.value.claimPass.available,
    constellation: actions.value.lightConstellation.available,
    solar: actions.value.claimSolar.available,
    qingmei: !!qingMei.value && (!qingMei.value.dailySeed.claimed || qingMei.value.actions.continue.available || qingMei.value.actions.settle.available),
  }))

  function reset() {
    requestVersion.value += 1
    loadInFlight = null
    snapshot.value = normalizeActivitySnapshot({})
    loading.value = false
    error.value = ''
    actionError.value = ''
    notice.value = ''
    loadedAccountId.value = ''
    successfulAccountId.value = ''
    serverClockOffset.value = 0
    pendingActions.value = { claimPass: false, lightConstellation: false, claimSolar: false, exchange: false, qingMeiSeed: false, qingMeiStart: false, qingMeiContinue: false, qingMeiSettle: false }
  }

  function isCurrent(version: number, accountId: string) {
    const storedAccountId = typeof localStorage === 'undefined' ? accountId : String(localStorage.getItem('current_account_id') || '')
    return requestVersion.value === version && storedAccountId === accountId
  }

  function disableQingMeiActions(activity: QingMeiActivityDto): QingMeiActivityDto {
    const disabledAction = (action: ActivityActionDto): ActivityActionDto => ({ ...action, enabled: false, available: false })
    return {
      ...activity,
      actions: {
        claimSeed: disabledAction(activity.actions.claimSeed),
        start: disabledAction(activity.actions.start),
        continue: disabledAction(activity.actions.continue),
        settle: disabledAction(activity.actions.settle),
      },
    }
  }

  function preserveQingMeiAfterUnknownMutation() {
    if (snapshot.value.qingMei) {
      snapshot.value = {
        ...snapshot.value,
        qingMei: disableQingMeiActions(snapshot.value.qingMei),
      }
    }
    return '青酿操作已提交，但最新状态暂未取回，请点击右上角刷新确认，不要重复操作'
  }

  function applySnapshot(value: unknown, clientStartedAt = Date.now(), preserveFailedQingMei = false) {
    const previousConstellation = snapshot.value.constellation
    const previousQingMei = snapshot.value.qingMei
    const normalized = normalizeActivitySnapshot(value)
    let warning = ''
    if (!normalized.constellation && normalized.errors.season && previousConstellation)
      normalized.constellation = previousConstellation
    if (!normalized.qingMei && normalized.errors.qingMei && previousQingMei) {
      normalized.qingMei = disableQingMeiActions(previousQingMei)
      if (preserveFailedQingMei)
        warning = '青酿操作已提交，但最新状态暂未取回，请点击右上角刷新确认，不要重复操作'
    }
    snapshot.value = normalized
    const serverTime = [normalized.season?.serverTime, normalized.shop?.serverTime, normalized.solarTerms?.serverTime, normalized.constellation?.serverTime]
      .find(value => value !== null && value !== undefined)
    if (serverTime !== undefined && serverTime !== null)
      serverClockOffset.value = serverTime - Math.round((clientStartedAt + Date.now()) / 2)
    return warning
  }

  async function load(accountId: string, force = false) {
    const requestedAccountId = String(accountId || '').trim()
    if (!requestedAccountId) {
      reset()
      error.value = '请先选择账号'
      return false
    }
    if (!force && loadedAccountId.value === requestedAccountId)
      return true
    if (loadInFlight?.accountId === requestedAccountId)
      return loadInFlight.promise

    const promise = (async () => {
      const version = ++requestVersion.value
      const clientStartedAt = Date.now()
      loading.value = true
      error.value = ''
      actionError.value = ''
      notice.value = ''
      if (loadedAccountId.value !== requestedAccountId) {
        snapshot.value = normalizeActivitySnapshot({})
        loadedAccountId.value = ''
        successfulAccountId.value = ''
        serverClockOffset.value = 0
      }

      try {
        const value = await fetchActivitySnapshot(requestedAccountId)
        if (!isCurrent(version, requestedAccountId))
          return false
        applySnapshot(value, clientStartedAt)
        loadedAccountId.value = requestedAccountId
        successfulAccountId.value = requestedAccountId
        return true
      }
      catch (loadError) {
        if (isCurrent(version, requestedAccountId)) {
          error.value = errorMessage(loadError)
          loadedAccountId.value = requestedAccountId
        }
        return false
      }
      finally {
        if (requestVersion.value === version)
          loading.value = false
      }
    })()
    loadInFlight = { accountId: requestedAccountId, promise }
    try {
      return await promise
    }
    finally {
      if (loadInFlight?.promise === promise)
        loadInFlight = null
    }
  }

  async function mutate(key: ActivityMutationKey, path: string, accountId: string, payload: ActivityRecord = {}) {
    const requestedAccountId = String(accountId || '').trim()
    if (!requestedAccountId || pendingActions.value[key])
      return false
    const version = requestVersion.value
    pendingActions.value[key] = true
    actionError.value = ''
    notice.value = ''
    try {
      const { result, responseData } = await postActivityMutation(path, requestedAccountId, payload)
      if (!isCurrent(version, requestedAccountId))
        return false
      const resultRecord = record(result)
      const mutationSnapshot = first(resultRecord.snapshot, resultRecord.activityCenter, resultRecord.activity_center)
      const mutationSnapshotError = text(resultRecord.snapshotError, resultRecord.snapshot_error)
      let snapshotWarning = ''
      if (mutationSnapshot)
        snapshotWarning = applySnapshot(mutationSnapshot, Date.now(), key.startsWith('qingMei'))
      else if (key.startsWith('qingMei') && mutationSnapshotError)
        snapshotWarning = preserveQingMeiAfterUnknownMutation()
      else
        await load(requestedAccountId, true)
      const rewards = records(resultRecord.rewards).map(normalizeItem).filter(item => item.id || item.name)
      const rewardSummary = rewards.map(item => `${item.name || item.id}${item.count ? ` ×${item.count}` : ''}`).join('、')
      notice.value = text(resultRecord.message, record(responseData).message, rewardSummary ? `获得 ${rewardSummary}` : '操作成功')
      if (snapshotWarning)
        actionError.value = snapshotWarning
      return true
    }
    catch (mutationError) {
      if (isCurrent(version, requestedAccountId))
        actionError.value = errorMessage(mutationError, '活动操作失败')
      return false
    }
    finally {
      pendingActions.value[key] = false
    }
  }

  function claimPass(accountId: string) {
    return mutate('claimPass', '/pass/claim', accountId)
  }

  function lightConstellation(accountId: string) {
    return mutate('lightConstellation', '/constellation/light', accountId)
  }

  function claimSolarTerm(accountId: string, termId: string) {
    return mutate('claimSolar', `/solar-terms/${encodeURIComponent(termId)}/claim`, accountId)
  }

  function exchangeStarSandGoods(accountId: string, goodsId: string, count: number) {
    return mutate('exchange', '/shop/exchange', accountId, { goodsId, count })
  }

  function claimQingMeiSeed(accountId: string) {
    return mutate('qingMeiSeed', '/qingmei/daily-seed/claim', accountId)
  }

  function startQingMeiBrew(accountId: string, ingredients: Array<{ uid: string, count: number }>) {
    return mutate('qingMeiStart', '/qingmei/brew/start', accountId, { ingredients })
  }

  function continueQingMeiBrew(accountId: string) {
    return mutate('qingMeiContinue', '/qingmei/brew/continue', accountId)
  }

  function settleQingMeiBrew(accountId: string) {
    return mutate('qingMeiSettle', '/qingmei/brew/settle', accountId)
  }

  function lazyLoad(accountId: string) {
    return load(accountId, false)
  }

  function refresh(accountId: string) {
    return load(accountId, true)
  }

  return {
    snapshot,
    season,
    shop,
    solar,
    solarTerms,
    constellation,
    qingMei,
    actions,
    tabBadges,
    loading,
    error,
    actionError,
    notice,
    loadedAccountId,
    successfulAccountId,
    serverClockOffset,
    serverNow,
    pendingActions,
    lazyLoad,
    refresh,
    claimPass,
    lightConstellation,
    claimSolarTerm,
    exchangeStarSandGoods,
    claimQingMeiSeed,
    startQingMeiBrew,
    continueQingMeiBrew,
    settleQingMeiBrew,
    reset,
  }
})
