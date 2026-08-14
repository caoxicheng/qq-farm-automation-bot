import type { ActivityRecord } from './types'
import api from '@/api'
import { responsePayload } from './normalize'

function requestOptions(accountId: string) {
  return {
    headers: { 'x-account-id': accountId },
    skipErrorToast: true,
  } as any
}

export async function fetchActivitySnapshot(accountId: string): Promise<unknown> {
  try {
    const response = await api.get('/api/activity-center/snapshot', requestOptions(accountId))
    return responsePayload(response.data)
  }
  catch (snapshotError: any) {
    if (snapshotError?.response?.status !== 404)
      throw snapshotError
    const [seasonResponse, shopResponse, solarResponse] = await Promise.all([
      api.get('/api/activity-center/season', requestOptions(accountId)),
      api.get('/api/activity-center/shop', requestOptions(accountId)),
      api.get('/api/activity-center/solar-terms', requestOptions(accountId)),
    ])
    return {
      season: responsePayload(seasonResponse.data),
      shop: responsePayload(shopResponse.data),
      solarTerms: responsePayload(solarResponse.data),
    }
  }
}

export async function postActivityMutation(path: string, accountId: string, payload: ActivityRecord) {
  const response = await api.post(`/api/activity-center${path}`, payload, {
    ...requestOptions(accountId),
    timeout: 155000,
  })
  return {
    result: responsePayload(response.data),
    responseData: response.data,
  }
}
