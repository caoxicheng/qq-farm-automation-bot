import type { ActivityTabKey } from './types'

export interface ActivityTabDefinition {
  key: ActivityTabKey
  label: string
  theme: 'day' | 'night'
  brandImage?: string
  showRefresh: boolean
  showBalance: boolean
}

export const activityTabs: readonly ActivityTabDefinition[] = [
  { key: 'travel', label: '千星游记', theme: 'night', showRefresh: true, showBalance: true },
  { key: 'constellation', label: '观星礼录', theme: 'night', brandImage: '/activity-center/stellar/activity-title.png', showRefresh: false, showBalance: false },
  { key: 'shop', label: '星砂商店', theme: 'night', showRefresh: true, showBalance: true },
  { key: 'solar', label: '节令小礼', theme: 'day', showRefresh: true, showBalance: false },
  { key: 'qingmei', label: '青酿换万金', theme: 'night', showRefresh: true, showBalance: false },
] as const

export const activityTabByKey = Object.fromEntries(
  activityTabs.map(tab => [tab.key, tab]),
) as Record<ActivityTabKey, ActivityTabDefinition>
