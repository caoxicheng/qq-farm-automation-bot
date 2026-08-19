import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export const useBagStore = defineStore('bag', () => {
  const allItems = ref<any[]>([])
  const originalItems = ref<any[]>([])
  const systemItems = ref<any[]>([])
  const loading = ref(false)
  const pendingFetches = new Map<string, Promise<void>>()

  function clearBag() {
    allItems.value = []
    originalItems.value = []
    systemItems.value = []
  }

  const items = computed(() => allItems.value)

  const dashboardItems = computed(() => {
    const targetIds = new Set([1011, 1012, 3001, 3002])
    return systemItems.value.filter((it: any) => targetIds.has(Number(it.id || 0)))
  })

  async function fetchBag(accountId: string) {
    if (!accountId)
      return
    const existing = pendingFetches.get(accountId)
    if (existing) {
      loading.value = true
      return existing
    }

    const requestedId = accountId
    const request = (async () => {
      loading.value = true
      try {
        const res = await api.get('/api/bag', {
          headers: { 'x-account-id': accountId },
        })
        const acc = useAccountStore()
        const curId = String((acc.currentAccountId as { value?: string })?.value ?? acc.currentAccountId ?? '')
        if (curId !== requestedId)
          return
        if (res.data.ok && res.data.data) {
          allItems.value = Array.isArray(res.data.data.items) ? res.data.data.items : []
          originalItems.value = Array.isArray(res.data.data.originalItems) ? res.data.data.originalItems : []
          systemItems.value = Array.isArray(res.data.data.systemItems) ? res.data.data.systemItems : []
        }
        else if (res.data && res.data.ok === false && res.data.error) {
          clearBag()
        }
      }
      catch (e) {
        const acc = useAccountStore()
        const curId = String((acc.currentAccountId as { value?: string })?.value ?? acc.currentAccountId ?? '')
        if (curId === requestedId)
          clearBag()
        console.error(e)
      }
    })()
    pendingFetches.set(accountId, request)

    try {
      await request
    }
    finally {
      if (pendingFetches.get(accountId) === request)
        pendingFetches.delete(accountId)
      const acc = useAccountStore()
      const currentId = String((acc.currentAccountId as { value?: string })?.value ?? acc.currentAccountId ?? '')
      if (currentId === accountId)
        loading.value = false
    }
  }

  async function useItem(accountId: string, itemId: number, count = 1, uid: string | number = 0) {
    const res = await api.post('/api/bag/use', { itemId, count, uid }, {
      headers: { 'x-account-id': accountId },
    })
    return res.data
  }

  async function sellItems(accountId: string, items: Array<{ id: number, count: number, uid?: string | number }>) {
    const res = await api.post('/api/bag/sell', { items }, {
      headers: { 'x-account-id': accountId },
    })
    return res.data
  }

  return { items, allItems, originalItems, systemItems, dashboardItems, loading, fetchBag, clearBag, useItem, sellItems }
})
