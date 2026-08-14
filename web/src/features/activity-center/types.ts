export type ActivityTabKey = 'travel' | 'constellation' | 'shop' | 'solar' | 'qingmei'
export type ActivityVariant = 'blue' | 'violet' | 'gold' | 'green'
export type ActivityRecord = Record<string, unknown>

export interface ActivityItemDto {
  id: string
  name: string
  count: string
  image: string
  rarity: string | number | null
}

export interface ActivityRewardDto extends ActivityItemDto {
  locked: boolean
  claimed: boolean
}

export interface ActivityRulesDto {
  title: string
  paragraphs: string[]
  lines?: string[]
}

export interface PassNodeDto {
  id: string
  level: string
  statusCode: string
  keyLevel: boolean
  locked: boolean
  claimed: boolean
  claimable: boolean
  current: boolean
  rewards: ActivityRewardDto[]
}

export interface TravelPassDto {
  activityId: string
  title: string
  description: string
  level: string | null
  progress: number | null
  progressMax: number | null
  claimedThroughLevel: string | null
  rules: ActivityRulesDto
  nodes: PassNodeDto[]
}

export interface ConstellationLinkDto {
  from: string
  to: string
}

export interface ConstellationNodeDto {
  id: string
  name: string
  description: string
  statusCode: string
  x: number | null
  y: number | null
  locked: boolean
  lit: boolean
  lightable: boolean
  current: boolean
  rewards: ActivityRewardDto[]
}

export type ConstellationVisualState = 'lit' | 'lightable' | 'claimableUnknown' | 'locked' | 'unknown'

export interface ConstellationGroupDto {
  id: string
  nodeId: string
  name: string
  category: string
  explain: string
  order: number | null
  chartIndex: number | null
  visualState: ConstellationVisualState
  opened: boolean | null
  lit: boolean | null
  stateKnown: boolean
  statusSource: string
  claimStatus: string
  nodeIds: string[]
  linksRaw: string
  rewards: ActivityRewardDto[]
  // Compatibility view for the current constellation component. Coordinates remain null
  // until an authoritative chart layout is supplied by the backend/catalog.
  current: boolean
  nodes: ConstellationNodeDto[]
  links: ConstellationLinkDto[]
}

export interface ConstellationDto {
  activityId: string
  typeCode: string
  displayName: string
  title: string
  serverName: string
  description: string
  startTime: number | null
  endTime: number | null
  serverTime: number | null
  catalogStatus: string
  rules: ActivityRulesDto
  currentDay: number | null
  groups: ConstellationGroupDto[]
}

export interface SeasonDto {
  id: string
  title: string
  description: string
  startTime: number | null
  endTime: number | null
  serverTime: number | null
  pass: TravelPassDto | null
}

export interface ShopCategoryDto {
  id: string
  name: string
}

export interface ShopGoodsDto {
  id: string
  name: string
  description: string
  categoryId: string
  categoryName: string
  item: ActivityItemDto
  cost: ActivityItemDto
  statusCode: string
  owned: boolean
  exchangeable: boolean
  soldOut: boolean
  balanceKnown: boolean
  maxExchangeCount: string
  maxExchangeCountKnown: boolean
}

export interface ShopCurrencyDto extends ActivityItemDto {
  balance: string | null
  balanceKnown: boolean
}

export interface ShopDto {
  activityId: string
  name: string
  title: string
  description: string
  startTime: number | null
  endTime: number | null
  serverTime: number | null
  balance: string | null
  balanceKnown: boolean
  currency: ActivityItemDto
  currencies: ShopCurrencyDto[]
  categories: ShopCategoryDto[]
  goods: ShopGoodsDto[]
  action: ActivityActionDto
}

export interface SolarTermDto {
  id: string
  name: string
  title: string
  englishName: string
  description: string
  rewardTitle: string
  rewardDescription: string
  statusCode: string
  startTime: number | null
  endTime: number | null
  current: boolean
  locked: boolean
  claimed: boolean
  claimable: boolean
  rewards: ActivityRewardDto[]
}

export interface SolarTermsDto {
  title: string
  description: string
  rewardTitle: string
  rewardDescription: string
  serverTime: number | null
  currentTermId: string
  terms: SolarTermDto[]
}

export interface QingMeiIngredientDto extends ActivityItemDto {
  uid: string
  mutantTypes: string[]
}

export interface QingMeiQuoteDto {
  round: number
  unitPrice: string
  totalGold: string
  doubled: boolean
}

export interface QingMeiActivityDto {
  activityId: string
  name: string
  startTime: number | null
  endTime: number | null
  ingredient: ActivityItemDto
  ingredients: QingMeiIngredientDto[]
  balance: string
  balanceKnown: boolean
  baseGold: string
  basePrice: string
  guaranteedPrice: string
  currentRound: number
  maxRounds: number
  started: boolean
  finished: boolean
  quotes: QingMeiQuoteDto[]
  quotePrices: string[]
  quoteTotals: string[]
  dailySeed: { claimed: boolean, grantId: string }
  actions: { claimSeed: ActivityActionDto, start: ActivityActionDto, continue: ActivityActionDto, settle: ActivityActionDto }
}

export interface ActivityActionDto {
  enabled: boolean
  available: boolean
  attemptable?: boolean
  attemptableCount?: number | null
  availabilityKnown: boolean
  count: number | null
}

export interface ActivityActionsDto {
  claimPass: ActivityActionDto
  lightConstellation: ActivityActionDto
  claimSolar: ActivityActionDto
  exchange: ActivityActionDto
}

export interface ActivityCenterSnapshotDto {
  season: SeasonDto | null
  shop: ShopDto | null
  solarTerms: SolarTermsDto | null
  constellation: ConstellationDto | null
  qingMei: QingMeiActivityDto | null
  actions: ActivityActionsDto
  errors: {
    season: string | null
    shop: string | null
    solarTerms: string | null
    qingMei: string | null
  }
}

export type ActivityMutationKey = 'claimPass' | 'lightConstellation' | 'claimSolar' | 'exchange' | 'qingMeiSeed' | 'qingMeiStart' | 'qingMeiContinue' | 'qingMeiSettle'
