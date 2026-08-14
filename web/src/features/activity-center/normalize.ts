import type {
  ActivityActionDto,
  ActivityCenterSnapshotDto,
  ActivityItemDto,
  ActivityRecord,
  ActivityRewardDto,
  ActivityRulesDto,
  ConstellationDto,
  ConstellationNodeDto,
  ConstellationVisualState,
  QingMeiActivityDto,
  SeasonDto,
  ShopDto,
  SolarTermsDto,
  TravelPassDto,
} from './types'

function isRecord(value: unknown): value is ActivityRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function record(value: unknown): ActivityRecord {
  return isRecord(value) ? value : {}
}

export function records(value: unknown): ActivityRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

export function first(...values: unknown[]): unknown {
  return values.find(value => value !== undefined && value !== null && value !== '')
}

export function text(...values: unknown[]): string {
  const value = first(...values)
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function bool(...values: unknown[]): boolean {
  const value = first(...values)
  if (typeof value === 'string')
    return ['1', 'true', 'yes'].includes(value.toLowerCase())
  return value === true || value === 1
}

function finiteNumber(value: unknown): number | null {
  if (value === '' || value === null || value === undefined)
    return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function toMilliseconds(value: unknown): number | null {
  if (value instanceof Date)
    return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value))
    return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric))
      return numeric < 1e12 ? numeric * 1000 : numeric
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function plainText(value: unknown): string {
  return text(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, '\'')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .trim()
}

function descriptionOf(raw: ActivityRecord): string {
  const rules = record(first(raw.rules, raw.rule, raw.content))
  const paragraphs = Array.isArray(rules.paragraphs) && rules.paragraphs.length ? rules.paragraphs : first(rules.lines, raw.paragraphs, raw.lines)
  return plainText(first(raw.description, raw.subtitle, raw.explain, Array.isArray(paragraphs) ? paragraphs.filter(Boolean).map(plainText).join('\n') : '', rules.title))
}

function normalizeRules(value: unknown): ActivityRulesDto {
  const raw = record(value)
  const entries = Array.isArray(raw.paragraphs) && raw.paragraphs.length
    ? raw.paragraphs
    : Array.isArray(raw.lines) ? raw.lines : []
  const paragraphs = entries
    .filter((entry): entry is string | number => typeof entry === 'string' || typeof entry === 'number')
    .map(plainText)
    .filter(Boolean)
  return {
    title: plainText(raw.title),
    paragraphs,
    lines: [...paragraphs],
  }
}

export function normalizeItem(value: unknown): ActivityItemDto {
  const raw = record(value)
  return {
    id: text(raw.id, raw.itemId, raw.item_id),
    name: text(raw.name, raw.itemName, raw.item_name, raw.title),
    count: text(raw.count, raw.quantity, raw.num, raw.amount),
    image: text(raw.image, raw.imageUrl),
    rarity: first(raw.rarity, raw.quality, raw.qualityCode) as string | number | null ?? null,
  }
}

function normalizeReward(value: unknown, inheritedLocked = false): ActivityRewardDto {
  const raw = record(value)
  const item = normalizeItem(isRecord(raw.item) ? { ...raw, ...raw.item } : raw)
  return {
    ...item,
    locked: inheritedLocked || bool(raw.locked, raw.isLocked),
    claimed: bool(raw.claimed, raw.received, raw.isClaimed),
  }
}

function statusIs(status: string, ...candidates: string[]): boolean {
  return candidates.includes(status.toLowerCase())
}

function normalizePass(value: unknown, seasonRaw: ActivityRecord): TravelPassDto | null {
  if (!isRecord(value))
    return null
  const raw = value
  const nodeValues = records(first(raw.nodes, raw.levels, raw.rewards, seasonRaw.rewards))
  const levelValue = first(raw.level, raw.currentLevel, raw.current_level, raw.field2Code, seasonRaw.level)
  const claimedThroughValue = first(raw.claimedThroughLevel, raw.claimed_through_level, raw.field9Code)
  const rules = normalizeRules(first(raw.rules, raw.rule, raw.content))
  return {
    activityId: text(raw.activityId, raw.activity_id, seasonRaw.activityId),
    title: text(raw.title, raw.name),
    description: descriptionOf(raw),
    level: levelValue === undefined || levelValue === null || levelValue === '' ? null : String(levelValue),
    progress: finiteNumber(first(raw.progress, raw.currentProgress, raw.current_progress, raw.points, raw.score, seasonRaw.progress)),
    progressMax: finiteNumber(first(raw.progressMax, raw.progressTarget, raw.progress_target, raw.progress_max, raw.target, raw.nextLevelProgress, seasonRaw.progressMax)),
    claimedThroughLevel: claimedThroughValue === undefined || claimedThroughValue === null || claimedThroughValue === '' ? null : String(claimedThroughValue),
    rules,
    nodes: nodeValues.map((node, index) => {
      const statusCode = text(node.statusCode, node.status, node.state)
      const claimed = bool(node.claimed, node.received, node.isClaimed) || statusIs(statusCode, '3', 'claimed', 'received')
      const explicitClaimable = bool(node.claimable, node.canClaim, node.available) || statusIs(statusCode, '2', 'claimable', 'available')
      const lockedValue = first(node.locked, node.isLocked)
      const locked = lockedValue === undefined || lockedValue === null || lockedValue === ''
        ? !claimed && !explicitClaimable
        : bool(lockedValue)
      return {
        id: text(node.id, node.nodeId, node.node_id, index),
        level: text(node.level, node.levelNo, node.level_no),
        statusCode,
        keyLevel: bool(node.keyLevel, node.key_level, node.isKeyLevel, node.is_key_level),
        locked,
        claimed,
        claimable: explicitClaimable && !claimed && !locked,
        current: bool(node.current, node.active, node.isCurrent),
        rewards: records(first(node.rewards, node.items, node.rewardList)).map(reward => normalizeReward(reward, locked)),
      }
    }),
  }
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === true || value === 1 || (typeof value === 'string' && ['1', 'true', 'yes'].includes(value.toLowerCase())))
    return true
  if (value === false || value === 0 || (typeof value === 'string' && ['0', 'false', 'no'].includes(value.toLowerCase())))
    return false
  return null
}

function constellationVisualState(value: unknown, opened: boolean | null, lit: boolean | null): ConstellationVisualState {
  if (value === 'lit' || value === 'lightable' || value === 'claimableUnknown' || value === 'locked' || value === 'unknown')
    return value
  // Compatibility for snapshots which expose the explicit booleans but not visualState.
  if (lit === true)
    return 'lit'
  if (opened === true)
    return 'lightable'
  if (opened === false)
    return 'locked'
  return 'unknown'
}

function normalizeConstellation(value: unknown): ConstellationDto | null {
  if (!isRecord(value))
    return null
  const raw = record(first(value.constellation, value.state, value))
  const activity = record(first(value.activity, value.activityInfo, value.activity_info))
  const rules = normalizeRules(first(raw.rules, value.rules))
  const currentDay = finiteNumber(first(raw.currentDay, raw.current_day))

  return {
    activityId: text(raw.activityId, raw.activity_id, value.activityId, value.activity_id, activity.id, activity.activityId),
    typeCode: text(raw.typeCode, raw.type_code, value.typeCode, activity.typeCode, activity.type),
    displayName: '观星礼录',
    title: '观星礼录',
    serverName: text(raw.serverName, raw.server_name, value.serverName, activity.name),
    description: rules.paragraphs.join('\n'),
    startTime: toMilliseconds(first(raw.startTime, raw.start_time, value.startTime, activity.startTime, activity.start_time)),
    endTime: toMilliseconds(first(raw.endTime, raw.end_time, value.endTime, activity.endTime, activity.end_time)),
    serverTime: toMilliseconds(first(raw.serverTime, raw.server_time, value.serverTime, value.server_time)),
    catalogStatus: text(raw.catalogStatus, raw.catalog_status),
    rules,
    currentDay,
    groups: records(first(raw.groups, value.groups)).map((group, groupIndex) => {
      const id = text(group.id, group.groupId, group.group_id, groupIndex + 1)
      const nodeId = text(group.nodeId, group.node_id, id)
      const order = finiteNumber(first(group.order, groupIndex + 1))
      const chartIndex = finiteNumber(first(group.chartIndex, group.chart_index))
      const opened = nullableBoolean(first(group.opened, group.isOpened, group.is_opened))
      const lit = nullableBoolean(first(group.lit, group.isLit, group.is_lit))
      const visualState = constellationVisualState(group.visualState, opened, lit)
      const stateKnownValue = nullableBoolean(first(group.stateKnown, group.state_known))
      const stateKnown = stateKnownValue ?? false
      const name = plainText(first(group.name, group.title))
      const explain = plainText(first(group.explain, group.description, group.subtitle))
      const rewards = records(first(group.rewards, group.items, group.rewardList)).map(reward => normalizeReward(reward))
      const current = currentDay !== null && order === currentDay
      const nodeIds = Array.isArray(group.nodeIds)
        ? group.nodeIds.map(nodeId => text(nodeId)).filter(Boolean)
        : []
      const compatibilityNode: ConstellationNodeDto = {
        id: nodeId,
        name,
        description: explain,
        statusCode: visualState,
        x: null,
        y: null,
        locked: visualState === 'locked',
        lit: lit === true,
        lightable: visualState === 'lightable',
        current,
        rewards,
      }
      return {
        id,
        nodeId,
        name,
        category: plainText(group.category),
        explain,
        order,
        chartIndex,
        visualState,
        opened,
        lit,
        stateKnown,
        statusSource: text(group.statusSource, group.status_source),
        claimStatus: text(group.claimStatus, group.claim_status),
        nodeIds,
        linksRaw: text(group.linksRaw, group.links_raw),
        rewards,
        current,
        nodes: [compatibilityNode],
        links: [],
      }
    }),
  }
}

function normalizeSeason(value: unknown): SeasonDto | null {
  if (!isRecord(value))
    return null
  const raw = value
  return {
    id: text(raw.id, raw.seasonId, raw.season_id),
    title: text(raw.title, raw.name),
    description: descriptionOf(raw),
    startTime: toMilliseconds(first(raw.startTime, raw.start_time, raw.beginTime, raw.begin_time)),
    endTime: toMilliseconds(first(raw.endTime, raw.end_time)),
    serverTime: toMilliseconds(first(raw.serverTime, raw.server_time)),
    pass: normalizePass(first(raw.pass, raw.travelPass, raw.travel_pass), raw),
  }
}

function normalizeShop(value: unknown): ShopDto | null {
  if (!isRecord(value))
    return null
  const raw = value
  const goodsValues = records(first(raw.goods, raw.items, raw.products, raw.list))
  const rawCurrencies = records(raw.currencies)
  const currencyRaw = record(first(raw.currencyItem, raw.currency_item, raw.balanceItem, raw.balance_item, rawCurrencies[0], isRecord(raw.currency) ? raw.currency : null))
  const firstCost = record(goodsValues[0]?.cost)
  const currency = normalizeItem(Object.keys(currencyRaw).length ? currencyRaw : firstCost)
  const explicitBalanceKnown = nullableBoolean(first(raw.balanceKnown, raw.balance_known))
  const currencies = rawCurrencies.map((entry) => {
    const balanceValue = first(entry.balance, entry.count)
    const knownValue = nullableBoolean(first(entry.balanceKnown, entry.balance_known))
    const balanceKnown = knownValue ?? (balanceValue !== undefined && balanceValue !== null && balanceValue !== '')
    return {
      ...normalizeItem(entry),
      balance: balanceKnown ? text(balanceValue) : null,
      balanceKnown,
    }
  })
  const fallbackBalance = first(raw.balance, currencyRaw.balance, !isRecord(raw.currency) ? raw.currency : undefined)
  const balanceKnown = explicitBalanceKnown ?? currencies[0]?.balanceKnown ?? (fallbackBalance !== undefined && fallbackBalance !== null && fallbackBalance !== '')
  const balance = balanceKnown ? text(currencies[0]?.balance, fallbackBalance, currencyRaw.count) : null
  const explicitCategories = Array.isArray(raw.categories) ? raw.categories : []
  const categories = explicitCategories.map((entry, index) => {
    const category = record(entry)
    return typeof entry === 'string'
      ? { id: entry, name: entry }
      : { id: text(category.id, category.categoryId, category.value, index), name: text(category.name, category.title, category.label) }
  }).filter(category => category.name)
  const goods = goodsValues.map((entry) => {
    const itemSource = isRecord(entry.item) ? entry.item : entry
    const costSource = isRecord(entry.cost) ? entry.cost : record(first(entry.priceItem, entry.price_item))
    const statusCode = text(entry.statusCode, entry.status_code, entry.status, entry.state)
    const goodsBalanceKnown = nullableBoolean(first(entry.balanceKnown, entry.balance_known)) ?? balanceKnown
    const maxExchangeCountValue = first(entry.maxExchangeCount, entry.max_exchange_count)
    const maxExchangeCountKnown = nullableBoolean(first(entry.maxExchangeCountKnown, entry.max_exchange_count_known))
      ?? (maxExchangeCountValue !== undefined && maxExchangeCountValue !== null && maxExchangeCountValue !== '')
    return {
      id: text(entry.id, entry.goodsId, entry.goods_id),
      name: text(entry.name, entry.title, entry.goodsName),
      description: descriptionOf(entry),
      categoryId: text(entry.categoryId, entry.category_id, entry.type, entry.category),
      categoryName: text(entry.categoryName, entry.category, entry.typeName),
      item: normalizeItem(itemSource),
      cost: normalizeItem({ ...costSource, count: first(costSource.count, entry.price, entry.needCount, entry.costCount) }),
      statusCode,
      owned: bool(entry.owned, entry.isOwned, entry.is_owned),
      exchangeable: bool(entry.exchangeable, entry.canExchange, entry.can_exchange),
      soldOut: bool(entry.soldOut, entry.sold_out, entry.disabled) || statusCode.toLowerCase() === 'soldout',
      balanceKnown: goodsBalanceKnown,
      maxExchangeCount: text(maxExchangeCountValue),
      maxExchangeCountKnown,
    }
  })
  for (const item of goods) {
    const categoryName = item.categoryName
    if (categoryName && !categories.some(category => category.name === categoryName || category.id === item.categoryId))
      categories.push({ id: item.categoryId || categoryName, name: categoryName })
  }
  const name = text(raw.name, raw.title)
  return {
    activityId: text(raw.activityId, raw.activity_id, raw.id),
    name,
    title: text(raw.title, name),
    description: descriptionOf(raw),
    startTime: toMilliseconds(first(raw.startTime, raw.start_time, raw.beginTime, raw.begin_time)),
    endTime: toMilliseconds(first(raw.endTime, raw.end_time)),
    serverTime: toMilliseconds(first(raw.serverTime, raw.server_time)),
    balance,
    balanceKnown,
    currency,
    currencies,
    categories,
    goods,
    action: normalizeAction({ exchange: raw.action }, {}, ['exchange']),
  }
}

function normalizeSolarTerms(value: unknown): SolarTermsDto | null {
  if (!isRecord(value))
    return null
  const raw = value
  const currentTermId = text(raw.currentTermId, raw.current_term_id)
  return {
    title: text(raw.title, raw.name),
    description: descriptionOf(raw),
    rewardTitle: text(raw.rewardTitle, raw.reward_title),
    rewardDescription: text(raw.rewardDescription, raw.reward_description),
    serverTime: toMilliseconds(first(raw.serverTime, raw.server_time)),
    currentTermId,
    terms: records(first(raw.terms, raw.items, raw.solarTerms, raw.solar_terms)).map((term) => {
      const statusCode = text(term.statusCode, term.status, term.state)
      const claimed = bool(term.claimed, term.received, term.isClaimed) || statusIs(statusCode, '3', 'claimed', 'received')
      const claimable = bool(term.claimable, term.canClaim, term.available) || statusCode === '2'
      return {
        id: text(term.id, term.termId, term.term_id),
        name: text(term.name, term.shortName),
        title: text(term.title, term.name),
        englishName: text(term.englishName, term.english_name, term.english),
        description: descriptionOf(term),
        rewardTitle: text(term.rewardTitle, term.reward_title),
        rewardDescription: text(term.rewardDescription, term.reward_description),
        statusCode,
        startTime: toMilliseconds(first(term.startTime, term.start_time, term.beginTime, term.begin_time)),
        endTime: toMilliseconds(first(term.endTime, term.end_time)),
        current: bool(term.current, term.active, term.isCurrent) || (!!currentTermId && text(term.id, term.termId, term.term_id) === currentTermId),
        locked: bool(term.locked, term.isLocked) || statusIs(statusCode, '0', 'locked'),
        claimed,
        claimable: claimable && !claimed,
        rewards: records(first(term.rewards, term.items, term.rewardList)).map(reward => normalizeReward(reward)),
      }
    }),
  }
}

function findAction(source: ActivityRecord, aliases: string[]): unknown {
  for (const alias of aliases) {
    if (source[alias] !== undefined)
      return source[alias]
  }
  return undefined
}

function normalizeAction(actions: ActivityRecord, capabilities: ActivityRecord, aliases: string[]): ActivityActionDto {
  const actionValue = findAction(actions, aliases)
  const capabilityValue = findAction(capabilities, aliases)
  const action = record(actionValue)
  const capability = record(capabilityValue)
  const count = finiteNumber(first(action.count, action.badge, action.availableCount, action.available_count))
  const enabled = typeof actionValue === 'boolean'
    ? actionValue
    : typeof capabilityValue === 'boolean'
      ? capabilityValue
      : bool(action.enabled, action.allowed, capability.enabled, capability.allowed, capability.available)
  const explicitAvailable = nullableBoolean(action.available)
  const available = typeof actionValue === 'boolean'
    ? actionValue
    : explicitAvailable !== null
      ? explicitAvailable
      : bool(action.pending, action.redDot, action.red_dot, action.active) || (count !== null && count > 0)
  const attemptableValue = nullableBoolean(first(action.attemptable, capability.attemptable))
  const attemptableCount = finiteNumber(first(action.attemptableCount, action.attemptable_count, capability.attemptableCount, capability.attemptable_count))
  const availabilityKnownValue = first(action.availabilityKnown, action.availability_known, capability.availabilityKnown, capability.availability_known)
  const availabilityKnown = availabilityKnownValue === undefined || availabilityKnownValue === null || availabilityKnownValue === ''
    ? typeof actionValue === 'boolean' || action.available !== undefined || count !== null
    : bool(availabilityKnownValue)
  return {
    enabled,
    available,
    ...(attemptableValue !== null ? { attemptable: attemptableValue } : {}),
    ...(attemptableCount !== null ? { attemptableCount } : {}),
    availabilityKnown,
    count,
  }
}

export function normalizeActivitySnapshot(value: unknown): ActivityCenterSnapshotDto {
  const envelope = record(value)
  const root = record(first(envelope.snapshot, envelope.data, value))
  const seasonRaw = first(root.season, root.seasonEvent, root.season_event)
  const seasonRecord = record(seasonRaw)
  const actionsRaw = record(first(root.actions, seasonRecord.actions))
  const capabilitiesRaw = record(first(root.capabilities, seasonRecord.capabilities, record(root.shop).capabilities, record(first(root.solarTerms, root.solar)).capabilities))
  const errorsRaw = record(root.errors)
  return {
    season: normalizeSeason(seasonRaw),
    shop: normalizeShop(first(root.shop, root.starSandShop, root.star_sand_shop)),
    solarTerms: normalizeSolarTerms(first(root.solarTerms, root.solar_terms, root.solar)),
    constellation: normalizeConstellation(first(root.constellation, root.constellationActivity, seasonRecord.constellation, seasonRecord.constellationActivity, seasonRecord.starContract, seasonRecord.contract)),
    qingMei: normalizeQingMei(first(root.qingMei, root.qingmei, root.qing_mei)),
    actions: {
      claimPass: normalizeAction(actionsRaw, capabilitiesRaw, ['claimPass', 'passClaim', 'pass_claim']),
      lightConstellation: normalizeAction(actionsRaw, capabilitiesRaw, ['lightConstellation', 'constellationLight', 'constellation_light']),
      claimSolar: normalizeAction(actionsRaw, capabilitiesRaw, ['claimSolar', 'solarClaim', 'solar_claim']),
      exchange: normalizeAction(actionsRaw, capabilitiesRaw, ['exchange', 'shopExchange', 'shop_exchange']),
    },
    errors: {
      season: text(errorsRaw.season) || null,
      shop: text(errorsRaw.shop) || null,
      solarTerms: text(errorsRaw.solarTerms, errorsRaw.solar_terms) || null,
      qingMei: text(errorsRaw.qingMei, errorsRaw.qingmei, errorsRaw.qing_mei) || null,
    },
  }
}

function normalizeQingMei(value: unknown): QingMeiActivityDto | null {
  if (!isRecord(value))
    return null
  const raw = record(value)
  const actionRaw = record(raw.actions)
  const capabilities = { claimSeed: true, start: true, continue: true, settle: true }
  const quoteTotals = Array.isArray(raw.quoteTotals) ? raw.quoteTotals.map(String) : []
  const quotePrices = Array.isArray(raw.quotePrices) ? raw.quotePrices.map(String) : []
  const quotes = records(raw.quotes).map((quote, index) => ({
    round: finiteNumber(first(quote.round, index + 1)) || index + 1,
    unitPrice: text(quote.unitPrice, quote.unit_price, '0'),
    totalGold: text(quote.totalGold, quote.total_gold, '0'),
    doubled: bool(quote.doubled),
  }))
  return {
    activityId: text(raw.activityId, raw.activity_id),
    name: text(raw.name, '青酿换万金'),
    startTime: toMilliseconds(first(raw.startTime, raw.start_time)),
    endTime: toMilliseconds(first(raw.endTime, raw.end_time)),
    ingredient: normalizeItem(raw.ingredient),
    ingredients: records(raw.ingredients).map(item => ({ ...normalizeItem(item), uid: text(item.uid), mutantTypes: Array.isArray(item.mutantTypes) ? item.mutantTypes.map(String) : [] })).filter(item => item.uid),
    balance: text(raw.balance, '0'),
    balanceKnown: raw.balanceKnown === undefined ? true : bool(raw.balanceKnown),
    baseGold: text(raw.baseGold, raw.base_gold, '0'),
    basePrice: text(raw.basePrice, raw.base_price, '0'),
    guaranteedPrice: text(raw.guaranteedPrice, raw.guaranteed_price, '0'),
    currentRound: finiteNumber(first(raw.currentRound, raw.current_round)) || 0,
    maxRounds: finiteNumber(first(raw.maxRounds, raw.max_rounds)) || 3,
    started: bool(raw.started),
    finished: bool(raw.finished),
    quotes: quotes.length > 0
      ? quotes
      : quoteTotals.map((totalGold, index) => ({ round: index + 1, unitPrice: quotePrices[index] || '0', totalGold, doubled: false })),
    quotePrices,
    quoteTotals,
    dailySeed: { claimed: bool(record(raw.dailySeed).claimed), grantId: text(record(raw.dailySeed).grantId, record(raw.dailySeed).grant_id) },
    actions: {
      claimSeed: normalizeAction(actionRaw, capabilities, ['claimSeed']),
      start: normalizeAction(actionRaw, capabilities, ['start']),
      continue: normalizeAction(actionRaw, capabilities, ['continue']),
      settle: normalizeAction(actionRaw, capabilities, ['settle']),
    },
  }
}

const activityErrorMessages: Record<string, string> = {
  1034038: '当前没有可点亮或可领取的星宿奖励，可能已经领取过，请稍后或明天再来看看',
  1034001: '当前活动暂不可操作，请稍后再试',
  1034002: '活动尚未开放或已经结束',
  NO_PASS_REWARD: '当前没有可领取的游记奖励，请完成新的游记等级后再试',
  SOLAR_TERM_UNAVAILABLE: '当前节令奖励暂不可领取，请在开放后再试',
  CONSTELLATION_UNAVAILABLE: '观星礼录活动暂未开放或已经结束',
  PASS_UNAVAILABLE: '千星游记活动暂未开放或已经结束',
  SOLAR_TERM_NOT_FOUND: '未找到该节令活动，请刷新页面后再试',
  SHOP_UNAVAILABLE: '星砂商店暂未开放，请稍后再来看看',
  INVALID_EXCHANGE_COUNT: '兑换数量必须是正整数',
  INVALID_SHOP_GOODS_ID: '商品信息无效，请刷新商店后重试',
  SHOP_GOODS_NOT_FOUND: '该商品已不在当前商店目录中，请刷新后重试',
  SHOP_GOODS_UNAVAILABLE: '该商品当前不可兑换，请刷新商店后重试',
  SHOP_BALANCE_UNAVAILABLE: '暂时无法确认星砂余额，请稍后重试',
  INSUFFICIENT_STAR_SAND: '星砂余额不足，无法完成本次兑换',
  SHOP_RESPONSE_INVALID: '商店数据已经变化，请刷新页面后重试',
  SEASON_UNAVAILABLE: '当前活动数据暂未开放，请稍后刷新重试',
  INVALID_SOLAR_TERM: '节令信息已失效，请刷新页面后重试',
  ACCOUNT_OFFLINE: '当前账号尚未运行，请先启动账号后再试',
  GAME_OFFLINE: '游戏连接尚未就绪，请稍后重试',
  ACTIVITY_TIMEOUT: '活动服务响应超时，请稍后重试',
  ACTIVITY_BUSY: '活动操作过于频繁，请稍后再试',
  ACTIVITY_REQUEST_INTERRUPTED: '活动请求未能完成，请稍后重试',
  ACTIVITY_DATA_CHANGED: '活动数据已经更新，请刷新页面后再试',
  ACTIVITY_OPERATION_FAILED: '活动操作失败，请刷新页面后重试',
}

export function errorMessage(error: unknown, fallback = '活动数据加载失败') {
  const candidate = error as { response?: { data?: { error?: unknown, message?: unknown, errorCode?: unknown } }, message?: unknown, code?: unknown }
  if (candidate.code === 'ECONNABORTED' && fallback === '活动操作失败')
    return '操作结果暂时未知，请先刷新活动状态确认，不要立即重复操作'
  const rawMessage = String(candidate.response?.data?.error || candidate.response?.data?.message || candidate.message || '')
  const errorCode = String(candidate.response?.data?.errorCode || candidate.code || rawMessage.match(/\bcode=(\d+)\b/)?.[1] || '')
  if (errorCode === 'ACTIVITY_TIMEOUT' && fallback === '活动操作失败')
    return '操作结果暂时未知，请先刷新活动状态确认，不要立即重复操作'
  if (activityErrorMessages[errorCode])
    return activityErrorMessages[errorCode]
  if (rawMessage.includes('当前无可领取的奖励节点'))
    return activityErrorMessages['1034038']!
  if (rawMessage.includes('当前没有可领取的游记奖励'))
    return activityErrorMessages.NO_PASS_REWARD!
  if (rawMessage.includes('指定节令当前不可领取'))
    return activityErrorMessages.SOLAR_TERM_UNAVAILABLE!
  if (/gamepb\.|code=\d+|GatewayError/.test(rawMessage))
    return fallback
  return rawMessage || fallback
}

export function responsePayload(value: unknown): unknown {
  const response = record(value)
  if (response.ok === false) {
    const responseError = new Error(text(response.error, response.message, '活动接口返回失败')) as Error & { code?: string }
    responseError.code = text(response.errorCode, response.error_code, response.code)
    throw responseError
  }
  return response.data !== undefined ? response.data : value
}
