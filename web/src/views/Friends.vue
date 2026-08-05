<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import LandCard from '@/components/LandCard.vue'
import { useAccountStore } from '@/stores/account'
import { useFriendStore } from '@/stores/friend'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const friendStore = useFriendStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const {
  friends,
  loading,
  friendLands,
  friendLandsLoading,
  blacklist,
  interactRecords,
  interactLoading,
  interactError,
  knownFriendGids,
  knownFriendGidSyncCooldownSec,
  friendsListCacheTtlSec,
  knownFriendSettingsLoading,
  knownFriendSettingsSaving,
} = storeToRefs(friendStore)
const { status, loading: statusLoading, realtimeConnected } = storeToRefs(statusStore)

const isQqAccount = computed(() => {
  const acc = currentAccount.value
  if (!acc)
    return false
  const platform = String(acc.platform || 'qq').toLowerCase()
  return platform === 'qq'
})

const knownFriendGidCount = computed(() => knownFriendGids.value.length)
const knownFriendGidSet = computed(() => new Set(knownFriendGids.value.map(Number)))
const friendGidSet = computed(() => new Set(friends.value.map(f => Number(f.gid))))
const blacklistGidSet = computed(() => new Set(blacklist.value.map(item => Number(item.gid))))
const showGidListModal = ref(false)
const gidSearchKeyword = ref('')

const filteredKnownFriendGids = computed(() => {
  const keyword = gidSearchKeyword.value.trim().toLowerCase()
  const list = knownFriendGids.value.map(gid => ({
    gid: Number(gid),
    synced: friendGidSet.value.has(Number(gid)),
  }))
  if (!keyword)
    return list
  return list.filter(item => String(item.gid).includes(keyword))
})

const syncedGidCount = computed(() => filteredKnownFriendGids.value.filter(item => item.synced).length)
const unsyncedGidCount = computed(() => filteredKnownFriendGids.value.filter(item => !item.synced).length)

async function handleRemoveGidFromList(gid: number) {
  if (!currentAccountId.value)
    return
  await friendStore.removeKnownFriendGid(currentAccountId.value, gid)
}

async function handleRemoveUnsyncedGids() {
  if (!currentAccountId.value)
    return
  const unsyncedGids = filteredKnownFriendGids.value.filter(item => !item.synced).map(item => item.gid)
  if (unsyncedGids.length === 0) {
    toast.info('没有需要删除的未同步 GID')
    return
  }
  const result = await friendStore.removeUnsyncedKnownFriendGids(currentAccountId.value, unsyncedGids)
  if (result.ok && result.removedCount > 0) {
    toast.success(`已删除 ${result.removedCount} 个未同步的 GID`)
  }
}

function openGidListModal() {
  gidSearchKeyword.value = ''
  showGidListModal.value = true
}

const TABS = [
  { key: 'friends', label: '好友列表', icon: 'i-carbon-user-multiple' },
  { key: 'blacklist', label: '好友黑名单', icon: 'i-carbon-list-blocked' },
  { key: 'visitors', label: '最近访客', icon: 'i-carbon-user-activity' },
] as const

type TabKey = typeof TABS[number]['key']

const activeTab = ref<TabKey>('friends')

const showConfirm = ref(false)
const confirmMessage = ref('')
const confirmLoading = ref(false)
const pendingAction = ref<(() => Promise<any>) | null>(null)
const avatarErrorKeys = ref<Set<string>>(new Set())
const searchKeyword = ref('')
const localKnownFriendGidSyncCooldownSec = ref(300)
const localFriendsListCacheTtlSec = ref(60)
const showBatchAddGidModal = ref(false)
const batchGidInput = ref('')

const interactFilter = ref('all')
const interactFilters = [
  { key: 'all', label: '全部' },
  { key: 'steal', label: '偷菜' },
  { key: 'help', label: '帮忙' },
  { key: 'bad', label: '捣乱' },
]

function confirmAction(msg: string, action: () => Promise<any>) {
  confirmMessage.value = msg
  pendingAction.value = action
  showConfirm.value = true
}

async function onConfirm() {
  if (pendingAction.value) {
    try {
      confirmLoading.value = true
      await pendingAction.value()
    }
    catch (e: any) {
      toast.error(e?.message || '操作失败')
    }
    finally {
      confirmLoading.value = false
      pendingAction.value = null
      showConfirm.value = false
    }
  }
  else {
    showConfirm.value = false
  }
}

const expandedFriends = ref<Set<string>>(new Set())
const currentPage = ref(1)
const pageSize = 25

const sortedFriends = computed(() => {
  return [...friends.value].sort((a: any, b: any) => {
    const levelA = Number(a?.level || 0)
    const levelB = Number(b?.level || 0)
    return levelB - levelA
  })
})

const filteredFriends = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()
  const list = sortedFriends.value
  if (!keyword)
    return list

  return list.filter((friend: any) => {
    const name = String(friend?.name || '').toLowerCase()
    const gid = String(friend?.gid || '')
    const uin = String(friend?.uin || '')
    return name.includes(keyword) || gid.includes(keyword) || uin.includes(keyword)
  })
})

const totalPages = computed(() => Math.ceil(filteredFriends.value.length / pageSize) || 1)

const paginatedFriends = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  const end = start + pageSize
  return filteredFriends.value.slice(start, end)
})

function goToPage(page: number) {
  currentPage.value = Math.max(1, Math.min(page, totalPages.value))
}

watch(searchKeyword, () => {
  currentPage.value = 1
})

const filteredInteractRecords = computed(() => {
  if (interactFilter.value === 'all')
    return interactRecords.value

  const actionTypeMap: Record<string, number> = {
    steal: 1,
    help: 2,
    bad: 3,
  }
  const targetActionType = actionTypeMap[interactFilter.value] || 0
  return interactRecords.value.filter((record: any) => Number(record?.actionType) === targetActionType)
})

const visibleInteractRecords = computed(() => filteredInteractRecords.value.slice(0, 50))

async function loadData() {
  if (currentAccountId.value) {
    const acc = currentAccount.value
    if (!acc)
      return

    if (!realtimeConnected.value) {
      await statusStore.fetchStatus(currentAccountId.value)
    }

    if (acc.running && status.value?.connection?.connected) {
      avatarErrorKeys.value.clear()
      friendStore.fetchFriends(currentAccountId.value)
      friendStore.fetchBlacklist(currentAccountId.value)
      friendStore.fetchInteractRecords(currentAccountId.value)
      if (isQqAccount.value) {
        friendStore.fetchKnownFriendSettings(currentAccountId.value)
      }
    }
  }
}

useIntervalFn(() => {
  for (const gid in friendLands.value) {
    if (friendLands.value[gid]) {
      friendLands.value[gid] = friendLands.value[gid].map((l: any) =>
        l.matureInSec > 0 ? { ...l, matureInSec: l.matureInSec - 1 } : l,
      )
    }
  }
}, 1000)

onMounted(() => {
  loadData()
})

watch(currentAccountId, () => {
  expandedFriends.value.clear()
  loadData()
})

async function handleRefreshFriends() {
  if (!currentAccountId.value)
    return
  try {
    await api.post('/api/friends/clear-cache', {}, {
      headers: { 'x-account-id': currentAccountId.value },
    })
  }
  catch {
    // ignore
  }
  await friendStore.fetchFriends(currentAccountId.value, true)
}

function toggleFriend(friendId: string) {
  if (expandedFriends.value.has(friendId)) {
    expandedFriends.value.delete(friendId)
  }
  else {
    expandedFriends.value.clear()
    expandedFriends.value.add(friendId)
    if (currentAccountId.value && currentAccount.value?.running && status.value?.connection?.connected) {
      friendStore.fetchFriendLands(currentAccountId.value, friendId)
    }
  }
}

async function handleOp(friendId: string, type: string, e: Event) {
  e.stopPropagation()
  if (!currentAccountId.value)
    return

  const opNames: Record<string, string> = {
    steal: '偷取',
    water: '浇水',
    weed: '除草',
    bug: '除虫',
    bad: '捣乱',
  }

  if (type === 'bad') {
    confirmAction('确定对好友执行捣乱操作吗?', async () => {
      toast.info('已在捣乱中，间隔较长，请稍后返回好友土地查看')
      friendStore.operate(currentAccountId.value!, friendId, type)
      return { ok: true }
    })
  }
  else {
    confirmAction(`确定对好友执行${opNames[type] || type}操作吗?`, async () => {
      const result = await friendStore.operate(currentAccountId.value!, friendId, type)
      if (result?.ok) {
        toast.success(result.message || `${opNames[type] || type}完成`)
      }
      else {
        toast.error(result?.message || `${opNames[type] || type}失败`)
      }
      return result
    })
  }
}

async function handleToggleBlacklist(friend: any, e: Event) {
  e.stopPropagation()
  if (!currentAccountId.value)
    return
  await friendStore.toggleBlacklist(currentAccountId.value, Number(friend.gid))
}

function getFriendStatusText(friend: any) {
  const p = friend.plant || {}
  const info = []
  if (p.stealNum)
    info.push(`偷${p.stealNum}`)
  if (p.dryNum)
    info.push(`水${p.dryNum}`)
  if (p.weedNum)
    info.push(`草${p.weedNum}`)
  if (p.insectNum)
    info.push(`虫${p.insectNum}`)
  return info.length ? info.join(' ') : '无操作'
}

function getFriendLevel(friend: any) {
  const level = Number.parseInt(String(friend?.level ?? ''), 10)
  if (!Number.isFinite(level) || level <= 0)
    return 0
  return level
}

function getFriendGold(friend: any) {
  const gold = Number.parseInt(String(friend?.gold ?? ''), 10)
  if (!Number.isFinite(gold) || gold < 0)
    return 0
  return gold
}

function formatFriendGold(value: unknown) {
  const gold = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(gold) || gold < 0)
    return '0'
  return gold.toLocaleString('zh-CN')
}

function getFriendAvatar(friend: any) {
  const direct = String(friend?.avatarUrl || friend?.avatar_url || '').trim()
  if (direct)
    return direct
  const uin = String(friend?.uin || '').trim()
  if (uin)
    return `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=100`
  return ''
}

function getFriendAvatarKey(friend: any) {
  const key = String(friend?.gid || friend?.uin || '').trim()
  return key || String(friend?.name || '').trim()
}

function canShowFriendAvatar(friend: any) {
  const key = getFriendAvatarKey(friend)
  if (!key)
    return false
  return !!getFriendAvatar(friend) && !avatarErrorKeys.value.has(key)
}

function handleFriendAvatarError(friend: any) {
  const key = getFriendAvatarKey(friend)
  if (!key)
    return
  avatarErrorKeys.value.add(key)
}

async function handleRemoveFromBlacklist(gid: number) {
  if (!currentAccountId.value)
    return
  await friendStore.toggleBlacklist(currentAccountId.value, gid)
}

async function refreshInteractRecords() {
  if (!currentAccountId.value)
    return
  await friendStore.fetchInteractRecords(currentAccountId.value)
}

function getInteractAvatar(record: any) {
  return String(record?.avatarUrl || '').trim()
}

function getInteractAvatarKey(record: any) {
  const key = String(record?.visitorGid || record?.key || record?.nick || '').trim()
  return key ? `interact:${key}` : ''
}

function canShowInteractAvatar(record: any) {
  const key = getInteractAvatarKey(record)
  if (!key)
    return false
  return !!getInteractAvatar(record) && !avatarErrorKeys.value.has(key)
}

function handleInteractAvatarError(record: any) {
  const key = getInteractAvatarKey(record)
  if (!key)
    return
  avatarErrorKeys.value.add(key)
}

function getInteractBadgeClass(actionType: number) {
  if (Number(actionType) === 1)
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  if (Number(actionType) === 2)
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
  if (Number(actionType) === 3)
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
}

function formatInteractTime(timestamp: number) {
  const ts = Number(timestamp) || 0
  if (!ts)
    return '--'

  const date = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minute = 60 * 1000
  const hour = 60 * minute

  if (diff >= 0 && diff < minute)
    return '刚刚'
  if (diff >= minute && diff < hour)
    return `${Math.floor(diff / minute)} 分钟前`

  const sameDay = now.getFullYear() === date.getFullYear()
    && now.getMonth() === date.getMonth()
    && now.getDate() === date.getDate()

  if (sameDay) {
    return `今天 ${date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })}`
  }

  if (now.getFullYear() === date.getFullYear()) {
    return `${date.getMonth() + 1}-${date.getDate()} ${date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })}`
  }

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function normalizeKnownFriendGidSyncCooldownSec(value: number) {
  const v = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(v) || v <= 0)
    return 600
  return Math.max(30, Math.min(86400, v))
}

function normalizeFriendsListCacheTtlSec(value: number) {
  const v = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(v) || v <= 0)
    return 60
  return Math.max(10, Math.min(86400, v))
}

async function handleRemoveKnownFriendGid(friend: any, e: Event) {
  e.stopPropagation()
  if (!currentAccountId.value)
    return
  const gid = Number(friend?.gid) || 0
  const name = String(friend?.name || `GID ${gid}`).trim()
  confirmAction(
    `确定将 ${name} 移出同步列表吗？后续如果最近访客再次命中，这个 GID 仍可被自动同步回来。`,
    async () => {
      await friendStore.removeKnownFriendGid(currentAccountId.value!, gid)
      await refreshFriendsAfterKnownGidChange()
      toast.success(`已移出同步列表: ${name}`)
    },
  )
}

async function refreshFriendsAfterKnownGidChange() {
  if (!currentAccountId.value)
    return
  await friendStore.fetchFriends(currentAccountId.value, true)
}

async function handleSaveKnownFriendSettings() {
  if (!currentAccountId.value)
    return
  const cooldownSec = normalizeKnownFriendGidSyncCooldownSec(localKnownFriendGidSyncCooldownSec.value)
  const cacheTtlSec = normalizeFriendsListCacheTtlSec(localFriendsListCacheTtlSec.value)
  await friendStore.saveKnownFriendSettings(currentAccountId.value, {
    knownFriendGidSyncCooldownSec: cooldownSec,
    friendsListCacheTtlSec: cacheTtlSec,
  })
  toast.success('设置已保存')
}

watch(knownFriendGidSyncCooldownSec, (val) => {
  localKnownFriendGidSyncCooldownSec.value = val
}, { immediate: true })

watch(friendsListCacheTtlSec, (val) => {
  localFriendsListCacheTtlSec.value = val
}, { immediate: true })

function parseBatchGids(input: string): number[] {
  const text = String(input || '').trim()
  if (!text)
    return []
  const gids: number[] = []
  const parts = text.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
  for (const part of parts) {
    const num = Number.parseInt(part, 10)
    if (Number.isFinite(num) && num > 0 && !gids.includes(num)) {
      gids.push(num)
    }
  }
  return gids
}

async function handleBatchAddKnownFriendGids() {
  if (!currentAccountId.value)
    return
  const gids = parseBatchGids(batchGidInput.value)
  if (gids.length === 0) {
    toast.error('请输入有效的 GID 列表')
    return
  }
  const result = await friendStore.batchAddKnownFriendGids(currentAccountId.value, gids)
  if (result.ok) {
    batchGidInput.value = ''
    showBatchAddGidModal.value = false
    await refreshFriendsAfterKnownGidChange()
    toast.success(`已批量添加 ${result.addedCount} 个 GID`)
  }
}
</script>

<template>
  <div class="p-4">
    <div class="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <h2 class="flex items-center gap-2 text-2xl font-bold">
        <div class="i-carbon-user-multiple" />
        好友
      </h2>
      <div class="flex items-center gap-3">
        <div v-if="activeTab === 'friends'" class="relative">
          <div class="i-carbon-search absolute left-3 top-1/2 text-gray-400 -translate-y-1/2" />
          <input
            v-model="searchKeyword"
            type="text"
            placeholder="搜索好友..."
            class="w-full border border-gray-300 rounded-lg bg-white py-2 pl-10 pr-4 text-sm sm:w-64 dark:border-gray-600 focus:border-blue-500 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
        </div>
        <div v-if="activeTab === 'friends' && friends.length" class="text-sm text-gray-500">
          共 {{ filteredFriends.length }}/{{ friends.length }} 名好友
        </div>
        <div v-if="activeTab === 'blacklist'" class="text-sm text-gray-500">
          共 {{ blacklist.length }} 人
        </div>
        <div v-if="activeTab === 'visitors' && interactRecords.length" class="text-sm text-gray-500">
          共 {{ filteredInteractRecords.length }}/{{ interactRecords.length }} 条记录
        </div>
      </div>
    </div>

    <div class="mb-4 flex border-b border-gray-200 dark:border-gray-700">
      <button
        v-for="tab in TABS"
        :key="tab.key"
        class="flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors"
        :class="activeTab === tab.key
          ? 'border-b-2'
          : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        :style="{ borderColor: activeTab === tab.key ? 'var(--theme-primary)' : 'transparent', color: activeTab === tab.key ? 'var(--theme-primary)' : undefined }"
        @click="activeTab = tab.key"
      >
        <div :class="tab.icon" />
        {{ tab.label }}
        <span
          v-if="tab.key === 'blacklist' && blacklist.length > 0"
          class="rounded-full bg-red-100 px-1.5 py-0.5 text-xs text-red-600 dark:bg-red-900/30 dark:text-red-400"
        >
          {{ blacklist.length }}
        </span>
      </button>
    </div>

    <div v-if="loading || statusLoading || interactLoading" class="flex justify-center py-12">
      <div class="i-svg-spinners-90-ring-with-bg text-4xl text-blue-500" />
    </div>

    <div v-else-if="!currentAccountId" class="flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center text-gray-500 shadow dark:bg-gray-800">
      <div class="i-carbon-user-offline text-4xl text-gray-400" />
      <div>
        <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
          未登录账号
        </div>
        <div class="mt-1 text-sm text-gray-400">
          请先添加农场账号
        </div>
      </div>
    </div>

    <div v-else-if="!status?.connection?.connected" class="flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center text-gray-500 shadow dark:bg-gray-800">
      <div class="i-carbon-connection-signal-off text-4xl text-gray-400" />
      <div>
        <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
          账号未登录
        </div>
        <div class="mt-1 text-sm text-gray-400">
          请先运行账号或检查网络连接
        </div>
      </div>
    </div>

    <template v-else>
      <div v-if="activeTab === 'friends'" class="space-y-4">
        <div v-if="currentAccountId && isQqAccount" class="mb-4 border border-amber-200 rounded-lg bg-white p-4 shadow dark:border-amber-700/50 dark:bg-gray-800">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div class="flex items-center gap-2">
                <div class="i-carbon-user-profile text-lg text-amber-500" />
                <h3 class="text-lg text-gray-700 font-semibold dark:text-gray-200">
                  QQ 好友自动同步
                </h3>
                <button
                  class="cursor-pointer rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 transition dark:bg-amber-900/30 hover:bg-amber-200 dark:text-amber-400 dark:hover:bg-amber-900/50"
                  @click="openGidListModal"
                >
                  {{ knownFriendGidCount }}
                </button>
              </div>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                QQ 新好友接口依赖已知 GID。系统会自动从最近访客补充，进入好友农场明确失败时自动移除失效 GID。
              </p>
            </div>
            <div class="flex shrink-0 gap-2">
              <button
                class="rounded bg-amber-100 px-3 py-1.5 text-sm text-amber-700 transition dark:bg-amber-900/30 hover:bg-amber-200 dark:text-amber-400 disabled:opacity-50 dark:hover:bg-amber-900/50"
                :disabled="knownFriendSettingsLoading"
                @click="currentAccountId && friendStore.fetchKnownFriendSettings(currentAccountId)"
              >
                <div v-if="knownFriendSettingsLoading" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
                刷新
              </button>
              <button
                class="rounded bg-green-100 px-3 py-1.5 text-sm text-green-700 transition dark:bg-green-900/30 hover:bg-green-200 dark:text-green-400 disabled:opacity-50 dark:hover:bg-green-900/50"
                :disabled="knownFriendSettingsSaving"
                @click="handleSaveKnownFriendSettings"
              >
                <div v-if="knownFriendSettingsSaving" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
                保存设置
              </button>
              <button
                class="rounded bg-blue-100 px-3 py-1.5 text-sm text-blue-700 transition dark:bg-blue-900/30 hover:bg-blue-200 dark:text-blue-400 disabled:opacity-50 dark:hover:bg-blue-900/50"
                @click="showBatchAddGidModal = true"
              >
                批量新增 GID
              </button>
            </div>
          </div>

          <div class="grid mt-4 gap-3 lg:grid-cols-2">
            <div>
              <label class="mb-1 block text-xs text-gray-500 dark:text-gray-400">访客检测入库冷却(秒)</label>
              <input
                v-model.number="localKnownFriendGidSyncCooldownSec"
                type="number"
                class="w-full border border-gray-300 rounded-lg bg-white px-3 py-2 text-sm dark:border-gray-600 focus:border-blue-500 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
            </div>
            <div>
              <label class="mb-1 block text-xs text-gray-500 dark:text-gray-400">好友列表缓存(秒)</label>
              <input
                v-model.number="localFriendsListCacheTtlSec"
                type="number"
                class="w-full border border-gray-300 rounded-lg bg-white px-3 py-2 text-sm dark:border-gray-600 focus:border-blue-500 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
            </div>
          </div>
        </div>

        <div v-if="friends.length === 0" class="rounded-lg bg-white p-8 text-center text-gray-500 shadow dark:bg-gray-800">
          暂无好友或数据加载失败
        </div>

        <template v-else>
          <div class="flex flex-wrap items-center gap-2 rounded-lg bg-white p-3 shadow dark:bg-gray-800">
            <div class="flex-1" />
            <button
              class="rounded bg-gray-100 px-3 py-1.5 text-sm text-gray-600 transition dark:bg-gray-700 hover:bg-gray-200 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-600"
              :disabled="loading"
              @click="handleRefreshFriends"
            >
              <div v-if="loading" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
              刷新列表
            </button>
          </div>

          <div
            v-for="friend in paginatedFriends"
            :key="friend.gid"
            class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800"
          >
            <div
              class="flex flex-col cursor-pointer justify-between gap-4 p-4 transition sm:flex-row sm:items-center hover:bg-gray-50 dark:hover:bg-gray-700/50"
              :class="blacklistGidSet.has(Number(friend.gid)) ? 'opacity-50' : ''"
              @click="toggleFriend(friend.gid)"
            >
              <div class="flex items-center gap-3">
                <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-1 ring-gray-100 dark:bg-gray-600 dark:ring-gray-700">
                  <img
                    v-if="canShowFriendAvatar(friend)"
                    :src="getFriendAvatar(friend)"
                    class="h-full w-full object-cover"
                    loading="lazy"
                    @error="handleFriendAvatarError(friend)"
                  >
                  <div v-else class="i-carbon-user text-gray-400" />
                </div>
                <div>
                  <div class="flex items-center gap-2 font-bold">
                    {{ friend.name }} ({{ friend.gid }})

                    <span v-if="blacklistGidSet.has(Number(friend.gid))" class="rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">已屏蔽</span>
                  </div>
                  <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                    <span
                      v-if="getFriendLevel(friend) > 0"
                      class="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500 dark:bg-gray-700 dark:text-gray-300"
                    >
                      Lv.{{ getFriendLevel(friend) }}
                    </span>
                    <span
                      v-if="getFriendGold(friend) > 0"
                      class="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
                    >
                      金币 {{ formatFriendGold(friend.gold) }}
                    </span>
                  </div>
                  <div class="text-sm" :class="getFriendStatusText(friend) !== '无操作' ? 'text-green-500 font-medium' : 'text-gray-400'">
                    {{ getFriendStatusText(friend) }}
                  </div>
                </div>
              </div>

              <div class="flex flex-wrap gap-2">
                <button
                  class="rounded bg-blue-100 px-3 py-2 text-sm text-blue-700 transition hover:bg-blue-200"
                  @click="handleOp(friend.gid, 'steal', $event)"
                >
                  偷取
                </button>
                <button
                  class="rounded bg-cyan-100 px-3 py-2 text-sm text-cyan-700 transition hover:bg-cyan-200"
                  @click="handleOp(friend.gid, 'water', $event)"
                >
                  浇水
                </button>
                <button
                  class="rounded bg-green-100 px-3 py-2 text-sm text-green-700 transition hover:bg-green-200"
                  @click="handleOp(friend.gid, 'weed', $event)"
                >
                  除草
                </button>
                <button
                  class="rounded bg-orange-100 px-3 py-2 text-sm text-orange-700 transition hover:bg-orange-200"
                  @click="handleOp(friend.gid, 'bug', $event)"
                >
                  除虫
                </button>
                <button
                  class="rounded bg-red-100 px-3 py-2 text-sm text-red-700 transition hover:bg-red-200"
                  @click="handleOp(friend.gid, 'bad', $event)"
                >
                  捣乱
                </button>
                <button
                  class="rounded px-3 py-2 text-sm transition"
                  :class="blacklistGidSet.has(Number(friend.gid))
                    ? 'bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700/50 dark:text-gray-400 dark:hover:bg-gray-700'"
                  @click="handleToggleBlacklist(friend, $event)"
                >
                  {{ blacklistGidSet.has(Number(friend.gid)) ? '移出黑名单' : '加入黑名单' }}
                </button>
                <button
                  v-if="isQqAccount && knownFriendGidSet.has(Number(friend.gid))"
                  class="rounded bg-amber-100 px-3 py-2 text-sm text-amber-700 transition dark:bg-amber-900/30 hover:bg-amber-200 dark:text-amber-400 dark:hover:bg-amber-900/50"
                  @click="handleRemoveKnownFriendGid(friend, $event)"
                >
                  移出同步列表
                </button>
              </div>
            </div>

            <div v-if="expandedFriends.has(friend.gid)" class="border-t bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
              <div v-if="friendLandsLoading[friend.gid]" class="flex justify-center py-4">
                <div class="i-svg-spinners-90-ring-with-bg text-2xl text-blue-500" />
              </div>
              <div v-else-if="!friendLands[friend.gid] || friendLands[friend.gid]?.length === 0" class="py-4 text-center text-gray-500">
                无土地数据
              </div>
              <div v-else class="grid grid-cols-2 gap-2 lg:grid-cols-8 md:grid-cols-5 sm:grid-cols-4">
                <LandCard
                  v-for="land in friendLands[friend.gid]"
                  :key="land.id"
                  :land="land"
                />
              </div>
            </div>
          </div>

          <!-- 分页控件 -->
          <div v-if="filteredFriends.length > pageSize" class="mt-4 flex flex-wrap items-center justify-center gap-2">
            <button
              class="border border-gray-200 rounded bg-white px-3 py-1.5 text-sm text-gray-600 transition dark:border-gray-600 dark:bg-gray-800 hover:bg-gray-50 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-700"
              :disabled="currentPage === 1"
              @click="goToPage(1)"
            >
              首页
            </button>
            <button
              class="border border-gray-200 rounded bg-white px-3 py-1.5 text-sm text-gray-600 transition dark:border-gray-600 dark:bg-gray-800 hover:bg-gray-50 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-700"
              :disabled="currentPage === 1"
              @click="goToPage(currentPage - 1)"
            >
              上一页
            </button>
            <div class="flex items-center gap-1">
              <template v-for="p in totalPages" :key="p">
                <button
                  v-if="p === 1 || p === totalPages || (p >= currentPage - 1 && p <= currentPage + 1)"
                  class="h-8 w-8 rounded text-sm transition"
                  :class="p === currentPage
                    ? 'text-white'
                    : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
                  :style="p === currentPage ? { backgroundColor: 'var(--theme-primary)' } : {}"
                  @click="goToPage(p)"
                >
                  {{ p }}
                </button>
                <span
                  v-else-if="p === currentPage - 2 || p === currentPage + 2"
                  class="px-1 text-gray-400"
                >...</span>
              </template>
            </div>
            <button
              class="border border-gray-200 rounded bg-white px-3 py-1.5 text-sm text-gray-600 transition dark:border-gray-600 dark:bg-gray-800 hover:bg-gray-50 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-700"
              :disabled="currentPage === totalPages"
              @click="goToPage(currentPage + 1)"
            >
              下一页
            </button>
            <button
              class="border border-gray-200 rounded bg-white px-3 py-1.5 text-sm text-gray-600 transition dark:border-gray-600 dark:bg-gray-800 hover:bg-gray-50 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-700"
              :disabled="currentPage === totalPages"
              @click="goToPage(totalPages)"
            >
              末页
            </button>
            <span class="text-sm text-gray-500 dark:text-gray-400">
              共 {{ filteredFriends.length }} 位好友
            </span>
          </div>
        </template>
      </div>

      <div v-else-if="activeTab === 'blacklist'" class="space-y-4">
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <p class="text-sm text-gray-500 dark:text-gray-400">
            加入黑名单的好友在自动偷菜和帮助时会被跳过。
          </p>
        </div>

        <div v-if="blacklist.length === 0" class="rounded-lg bg-white p-8 text-center text-gray-500 shadow dark:bg-gray-800">
          <div class="i-carbon-list-blocked mx-auto mb-3 text-4xl text-gray-300" />
          暂无黑名单好友
        </div>

        <div v-else class="space-y-2">
          <div
            v-for="item in blacklist"
            :key="item.gid"
            class="flex items-center justify-between rounded-lg bg-white p-4 shadow dark:bg-gray-800"
          >
            <div class="flex items-center gap-3">
              <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-1 ring-gray-100 dark:bg-gray-600 dark:ring-gray-700">
                <img
                  v-if="item.avatarUrl"
                  :src="item.avatarUrl"
                  class="h-full w-full object-cover"
                  loading="lazy"
                  @error="($event.target as HTMLImageElement).style.display = 'none'"
                >
                <div v-else class="i-carbon-user text-gray-400" />
              </div>
              <div>
                <span class="font-medium">{{ item.name || `GID:${item.gid}` }}</span>
                <span class="ml-2 text-sm text-gray-400">({{ item.gid }})</span>
              </div>
            </div>
            <button
              class="rounded bg-red-100 px-3 py-1.5 text-sm text-red-600 dark:bg-red-900/30 hover:bg-red-200 dark:text-red-400 dark:hover:bg-red-900/50"
              @click="handleRemoveFromBlacklist(item.gid)"
            >
              移出黑名单
            </button>
          </div>
        </div>
      </div>

      <div v-else-if="activeTab === 'visitors'" class="space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          <button
            v-for="item in interactFilters"
            :key="item.key"
            class="rounded-full px-3 py-1 text-xs transition"
            :class="interactFilter === item.key
              ? 'text-white'
              : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'"
            :style="interactFilter === item.key ? { backgroundColor: 'var(--theme-primary)' } : {}"
            @click="interactFilter = item.key"
          >
            {{ item.label }}
          </button>
          <button
            class="rounded bg-gray-100 px-3 py-1.5 text-xs text-gray-600 transition disabled:cursor-not-allowed dark:bg-gray-700 hover:bg-gray-200 dark:text-gray-300 disabled:opacity-60 dark:hover:bg-gray-600"
            :disabled="interactLoading"
            @click="refreshInteractRecords"
          >
            {{ interactLoading ? '刷新中...' : '刷新' }}
          </button>
        </div>

        <div v-if="!!interactError" class="rounded-lg bg-red-50 px-4 py-6 text-center text-sm text-red-600 dark:bg-red-900/20 dark:text-red-300">
          {{ interactError }}
        </div>

        <div v-else-if="visibleInteractRecords.length === 0" class="rounded-lg bg-white p-8 text-center text-gray-500 shadow dark:bg-gray-800">
          <div class="i-carbon-user-activity mx-auto mb-3 text-4xl text-gray-300" />
          暂无访客记录
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="record in visibleInteractRecords"
            :key="record.key"
            class="flex items-start gap-3 rounded-lg bg-white p-4 shadow dark:bg-gray-800"
          >
            <div class="h-12 w-12 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-1 ring-gray-100 dark:bg-gray-700 dark:ring-gray-600">
              <img
                v-if="canShowInteractAvatar(record)"
                :src="getInteractAvatar(record)"
                class="h-full w-full object-cover"
                loading="lazy"
                @error="handleInteractAvatarError(record)"
              >
              <div v-else class="i-carbon-user-avatar text-xl text-gray-400" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="mb-1 flex flex-wrap items-center gap-2">
                <span class="max-w-full truncate text-base text-gray-800 font-medium dark:text-gray-100">
                  {{ record.nick || `GID:${record.visitorGid}` }}
                </span>
                <span
                  class="rounded-full px-2 py-0.5 text-xs font-medium"
                  :class="getInteractBadgeClass(record.actionType)"
                >
                  {{ record.actionLabel }}
                </span>
                <span v-if="record.level" class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                  Lv.{{ record.level }}
                </span>
                <span v-if="record.visitorGid" class="text-xs text-gray-400">
                  GID {{ record.visitorGid }}
                </span>
              </div>
              <div class="text-sm text-gray-600 dark:text-gray-300">
                {{ record.actionDetail || record.actionLabel }}
              </div>
            </div>
            <div class="shrink-0 text-right text-xs text-gray-400">
              {{ formatInteractTime(record.serverTimeMs) }}
            </div>
          </div>

          <div v-if="filteredInteractRecords.length > visibleInteractRecords.length" class="text-center text-xs text-gray-400">
            仅展示最近 {{ visibleInteractRecords.length }} 条
          </div>
        </div>
      </div>
    </template>

    <ConfirmModal
      :show="showConfirm"
      :loading="confirmLoading"
      title="确认操作"
      :message="confirmMessage"
      @confirm="onConfirm"
      @cancel="!confirmLoading && (showConfirm = false)"
    />

    <Teleport to="body">
      <div
        v-if="showBatchAddGidModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        @click.self="showBatchAddGidModal = false"
      >
        <div class="max-w-lg w-full rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
          <h3 class="mb-4 text-lg text-gray-800 font-semibold dark:text-gray-100">
            批量新增 GID
          </h3>
          <p class="mb-3 text-sm text-gray-500 dark:text-gray-400">
            支持一行一个或用逗号/空格分隔，自动去重
          </p>
          <textarea
            v-model="batchGidInput"
            rows="8"
            placeholder="每行一个 GID，或用逗号、空格分隔&#10;例如：&#10;12345678&#10;87654321&#10;或&#10;12345678, 87654321, 11111111"
            class="mb-4 w-full border border-gray-300 rounded-lg bg-white p-3 text-sm dark:border-gray-600 focus:border-blue-500 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <div class="flex justify-end gap-3">
            <button
              class="border border-gray-300 rounded-lg bg-white px-4 py-2 text-sm text-gray-700 transition dark:border-gray-600 dark:bg-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-600"
              @click="showBatchAddGidModal = false"
            >
              取消
            </button>
            <button
              class="rounded-lg px-4 py-2 text-sm text-white transition disabled:opacity-50"
              :disabled="knownFriendSettingsSaving || !batchGidInput.trim()"
              :style="{ backgroundColor: 'var(--theme-primary)' }"
              @click="handleBatchAddKnownFriendGids"
            >
              <div v-if="knownFriendSettingsSaving" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
              确认添加
            </button>
          </div>
        </div>
      </div>

      <div
        v-if="showGidListModal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        @click.self="showGidListModal = false"
      >
        <div class="max-h-[80vh] max-w-2xl w-full flex flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800">
          <div class="flex shrink-0 items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
            <div>
              <h3 class="text-lg text-gray-800 font-semibold dark:text-gray-100">
                已导入的 GID 列表
              </h3>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                共 {{ knownFriendGidCount }} 个 GID，
                <span class="text-yellow-600 dark:text-yellow-400">已同步 {{ syncedGidCount }} 个</span>，
                <span class="text-red-600 dark:text-red-400">未同步 {{ unsyncedGidCount }} 个</span>
              </p>
            </div>
            <button
              class="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 dark:hover:bg-gray-700"
              @click="showGidListModal = false"
            >
              <div class="i-carbon-close text-xl" />
            </button>
          </div>

          <div class="shrink-0 border-b border-gray-200 p-4 dark:border-gray-700">
            <div class="flex gap-2">
              <input
                v-model="gidSearchKeyword"
                type="text"
                placeholder="搜索 GID..."
                class="flex-1 border border-gray-300 rounded-lg bg-white px-3 py-2 text-sm dark:border-gray-600 focus:border-blue-500 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
              <button
                class="shrink-0 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-700 transition dark:bg-red-900/30 hover:bg-red-200 dark:text-red-400 disabled:opacity-50 dark:hover:bg-red-900/50"
                :disabled="knownFriendSettingsSaving || unsyncedGidCount === 0"
                @click="handleRemoveUnsyncedGids"
              >
                <div v-if="knownFriendSettingsSaving" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
                删除未同步 ({{ unsyncedGidCount }})
              </button>
            </div>
          </div>

          <div class="flex-1 overflow-y-auto p-4">
            <div v-if="filteredKnownFriendGids.length === 0" class="py-8 text-center text-gray-500 dark:text-gray-400">
              暂无数据
            </div>
            <div v-else class="grid gap-2 lg:grid-cols-3 sm:grid-cols-2">
              <div
                v-for="item in filteredKnownFriendGids"
                :key="item.gid"
                class="flex items-center justify-between border rounded-lg p-2 transition"
                :class="[
                  item.synced
                    ? 'border-yellow-300 bg-yellow-50 dark:border-yellow-700/50 dark:bg-yellow-900/20'
                    : 'border-red-300 bg-red-50 dark:border-red-700/50 dark:bg-red-900/20',
                ]"
              >
                <div class="flex items-center gap-2">
                  <span
                    class="text-sm font-mono"
                    :class="item.synced ? 'text-yellow-700 dark:text-yellow-400' : 'text-red-700 dark:text-red-400'"
                  >
                    {{ item.gid }}
                  </span>
                  <span
                    v-if="item.synced"
                    class="rounded bg-yellow-200 px-1 py-0.5 text-xs text-yellow-700 dark:bg-yellow-800/50 dark:text-yellow-300"
                  >
                    已同步
                  </span>
                  <span
                    v-else
                    class="rounded bg-red-200 px-1 py-0.5 text-xs text-red-700 dark:bg-red-800/50 dark:text-red-300"
                  >
                    未同步
                  </span>
                </div>
                <button
                  class="rounded p-1 text-gray-400 transition hover:bg-gray-200 hover:text-red-500 dark:hover:bg-gray-700"
                  :disabled="knownFriendSettingsSaving"
                  @click="handleRemoveGidFromList(item.gid)"
                >
                  <div class="i-carbon-trash-can text-sm" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
