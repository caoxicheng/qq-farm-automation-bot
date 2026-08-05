const __create = Object.create;
const __defProp = Object.defineProperty;
const __getOwnPropDesc = Object.getOwnPropertyDescriptor;
const __getOwnPropNames = Object.getOwnPropertyNames;
const __getProtoOf = Object.getPrototypeOf;
const __hasOwnProp = Object.prototype.hasOwnProperty;
const __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (const key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
const __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps( // eslint-disable-line no-sequences
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const import_constellation_2026072701 = __toESM(require("../activity-data/constellation-2026072701.json"));
const LongModule = require("long");
const { sendMsgAsync, GatewayError } = require("../utils/network");
const { types } = require("../utils/proto");
const { getItemById, getItemImageById } = require("../config/gameConfig");
const { getBag, getBagItems } = require("./warehouse");
const {
  mergeConstellationStates,
  stateRecordKey,
  loadConstellationState,
  persistConstellationState,
  stateFromDynamicNodes,
  stateWithNoClaimableDay
} = require("./activity-center-state");
const SHOP_ACTIVITY_TYPE = "3";
const CONSTELLATION_ACTIVITY_TYPE = "13";
const EXCHANGE_SHOP_OPERATE_TYPE = 1;
const QUERY_SHOP_OPERATE_TYPE = 7;
const LIGHT_CONSTELLATION_OPERATE_TYPE = 21;
const MAX_SIGNED_INT64 = 9223372036854775807n;
const SECONDS_PER_DAY = 86400;
const BEIJING_UTC_OFFSET_SECONDS = 8 * 60 * 60;
class ActivityBusinessError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "ActivityBusinessError";
    this.code = code;
  }
}
function businessError(code, message) {
  return new ActivityBusinessError(code, message);
}
function positiveDecimal(value, code, fieldName) {
  let normalized = "";
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    normalized = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    normalized = String(value);
  }
  if (!normalized || normalized.length > 19 || BigInt(normalized) > MAX_SIGNED_INT64) {
    throw businessError(code, `${fieldName} \u5FC5\u987B\u662F int64 \u8303\u56F4\u5185\u7684\u6B63\u5341\u8FDB\u5236\u6574\u6570`);
  }
  return normalized;
}
let mutationTail = Promise.resolve();
const lastConstellationState = /* @__PURE__ */ new Map();
const lastConstellationDynamicState = /* @__PURE__ */ new Map();
function int64String(value) {
  if (value == null) return "0";
  if (LongModule.isLong(value)) return value.toString();
  if (typeof value === "string") return /^-?\d+$/.test(value) ? value : "0";
  return Number.isSafeInteger(value) ? String(value) : "0";
}
function int64Number(value) {
  const parsed = Number(int64String(value));
  return Number.isSafeInteger(parsed) ? parsed : 0;
}
function compareInt64(left, right) {
  const leftValue = BigInt(int64String(left));
  const rightValue = BigInt(int64String(right));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
function constellationDayFromBeijingMidnight(startTimeSec, serverTimeSec) {
  if (startTimeSec <= 0 || serverTimeSec < startTimeSec) return null;
  const startDateIndex = Math.floor((startTimeSec + BEIJING_UTC_OFFSET_SECONDS) / SECONDS_PER_DAY);
  const serverDateIndex = Math.floor((serverTimeSec + BEIJING_UTC_OFFSET_SECONDS) / SECONDS_PER_DAY);
  return serverDateIndex - startDateIndex + 1;
}
function bytesToText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  const buffer = Buffer.from(value);
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gb18030").decode(buffer);
  } catch {
    return utf8;
  }
}
function plainText(value) {
  return String(value || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
}
function findStrings(value, output) {
  if (typeof value === "string") {
    const text = plainText(value);
    if (text) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => findStrings(entry, output));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => findStrings(entry, output));
  }
}
function textContent(value) {
  const text = bytesToText(value).trim();
  if (!text) return { title: "", paragraphs: [] };
  try {
    const parsed = JSON.parse(text);
    const tips = parsed && typeof parsed === "object" ? parsed.tips : null;
    const rawParagraphs = tips && Array.isArray(tips.txt) ? tips.txt : [];
    const paragraphs = rawParagraphs.filter((entry) => typeof entry === "string").map(plainText).filter(Boolean);
    if (paragraphs.length) {
      return { title: typeof tips?.title === "string" ? plainText(tips.title) : "", paragraphs };
    }
    const allText = [];
    findStrings(parsed, allText);
    return { title: "", paragraphs: Array.from(new Set(allText)) };
  } catch {
    return { title: "", paragraphs: [plainText(text)].filter(Boolean) };
  }
}
function parseJsonText(value) {
  const text = bytesToText(value).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function parseNestedJsonValue(value, depth = 0) {
  if (depth >= 6) return value;
  if (Array.isArray(value)) return value.map((entry) => parseNestedJsonValue(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, parseNestedJsonValue(entry, depth + 1)]));
  }
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return value;
  try {
    return parseNestedJsonValue(JSON.parse(text), depth + 1);
  } catch {
  }
  let encoded = text;
  for (let nesting = 0; nesting < 3; nesting += 1) {
    if (encoded.length < 4 || encoded.length % 4 === 1 || !/^[A-Z0-9+/]+={0,2}$/i.test(encoded)) break;
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8").trim();
    if (!decoded || decoded.includes("\uFFFD")) break;
    try {
      return parseNestedJsonValue(JSON.parse(decoded), depth + 1);
    } catch {
      encoded = decoded;
    }
  }
  return value;
}
function parseActivityExtra(value) {
  const parsed = parseJsonText(value);
  return parseNestedJsonValue(parsed);
}
function itemDto(item) {
  const rawId = item?.item_id ?? item?.itemId ?? item?.id;
  const id = int64String(rawId);
  const numericId = int64Number(rawId);
  const metadata = numericId > 0 ? getItemById(numericId) : void 0;
  return {
    id,
    count: int64String(item?.count),
    name: metadata?.name || bytesToText(item?.name),
    image: numericId > 0 ? getItemImageById(numericId) : "",
    rarity: Number(metadata?.rarity) || 0
  };
}
function activityDto(activity) {
  return {
    id: int64String(activity?.activity_id),
    typeCode: int64String(activity?.type),
    name: bytesToText(activity?.name),
    startTime: int64String(activity?.begin_time),
    endTime: int64String(activity?.end_time),
    extra: parseActivityExtra(activity?.extra)
  };
}
function passDto(pass) {
  if (!pass) return null;
  const currentLevel = int64String(pass.current_level ?? pass.field_2);
  const progress = int64String(pass.current_progress ?? pass.field_4);
  const progressMax = int64String(pass.progress_target ?? pass.field_5);
  const claimedThroughLevel = int64String(pass.claimed_through_level ?? pass.field_9);
  const nodes = (Array.isArray(pass.nodes) ? pass.nodes : []).map((node) => {
    const level = int64String(node.node_id);
    const claimed = level !== "0" && compareInt64(level, claimedThroughLevel) <= 0;
    const locked = level === "0" || compareInt64(level, currentLevel) > 0;
    return {
      id: level,
      level,
      keyLevel: !!(node.is_key_level ?? node.field_4),
      locked,
      claimed,
      claimable: !locked && !claimed,
      current: level !== "0" && compareInt64(level, currentLevel) === 0,
      rewards: (Array.isArray(node.rewards) ? node.rewards : []).map(itemDto)
    };
  });
  return {
    activityId: int64String(pass.activity_id),
    title: bytesToText(pass.title),
    level: currentLevel,
    progress,
    progressMax,
    claimedThroughLevel,
    nodeCount: int64String(pass.node_count),
    field11Code: int64String(pass.field_11),
    field13Code: int64String(pass.field_13),
    field18Code: int64String(pass.field_18),
    field14Items: (Array.isArray(pass.field_14) ? pass.field_14 : []).map(itemDto),
    rules: textContent(pass.rules_json),
    nodes
  };
}
function solarTermDto(term) {
  if (!term) return null;
  const statusCode = int64String(term.status);
  return {
    id: int64String(term.term_id),
    name: bytesToText(term.name),
    statusCode,
    canClaim: statusCode === "2",
    startTime: int64String(term.begin_time),
    endTime: int64String(term.end_time),
    rewards: (Array.isArray(term.rewards) ? term.rewards : []).map(itemDto)
  };
}
function rawConstellationNode(node) {
  return {
    id: int64String(node?.node_id),
    field2: !!node?.field_2,
    field3: !!node?.field_3,
    field4: !!node?.field_4,
    rewards: (Array.isArray(node?.rewards) ? node.rewards : []).map(itemDto)
  };
}
function rawConstellationGroup(group) {
  return {
    id: int64String(group?.group_id),
    field2: !!group?.field_2,
    name: bytesToText(group?.name),
    links: parseJsonText(group?.links),
    config: parseJsonText(group?.config_json)
  };
}
function constellationStateIdentity(seasonReply, activity) {
  return {
    seasonId: int64String(seasonReply?.season_info?.season_id),
    activityId: int64String(activity?.activity_id ?? activity?.id),
    catalogVersion: Number(import_constellation_2026072701.default.catalogVersion) || 0
  };
}
function loadMergedConstellationState(seasonReply, activity) {
  const identity = constellationStateIdentity(seasonReply, activity);
  const memoryState = lastConstellationState.get(stateRecordKey(identity));
  return mergeConstellationStates(identity, loadConstellationState(identity), memoryState);
}
function constellationDto(activity, serverTimeValue, data, confirmedState) {
  const activityId = int64String(activity?.activity_id ?? activity?.id);
  const catalogSupported = activityId === String(import_constellation_2026072701.default.activityId);
  const startTime = int64String(activity?.begin_time ?? activity?.startTime);
  const endTime = int64String(activity?.end_time ?? activity?.endTime);
  const serverTime = int64String(serverTimeValue);
  const activityMetadata = activityDto(activity);
  if (!catalogSupported) {
    return {
      activityId,
      typeCode: int64String(activity?.type ?? activity?.typeCode),
      displayName: activityMetadata.name,
      serverName: activityMetadata.name,
      startTime,
      endTime,
      serverTime,
      catalogVersion: null,
      catalogStatus: "unsupported",
      rules: null,
      currentDay: null,
      groups: []
    };
  }
  const start = int64Number(startTime);
  const server = int64Number(serverTime);
  const calculatedDay = constellationDayFromBeijingMidnight(start, server);
  const currentDay = calculatedDay == null ? null : Math.max(1, Math.min(28, calculatedDay));
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const dynamicNodes = new Map(nodes.map((node) => [int64String(node?.node_id), node]));
  const dynamicGroups = new Map((Array.isArray(data?.groups) ? data.groups : []).map((group) => [int64String(group?.group_id), group]));
  const confirmedOpenedNodeIds = new Set(confirmedState?.confirmedOpenedNodeIds || []);
  const confirmedLitNodeIds = new Set(confirmedState?.confirmedLitNodeIds || []);
  const noClaimableDays = confirmedState?.noClaimableDays || {};
  const groups = import_constellation_2026072701.default.groups.map((group) => {
    const id = String(group.id);
    const nodeId = String(group.nodeId);
    const dynamicNode = dynamicNodes.get(nodeId);
    const dynamicGroup = dynamicGroups.get(id);
    const confirmedOpened = confirmedOpenedNodeIds.has(nodeId);
    const confirmedLit = confirmedLitNodeIds.has(nodeId);
    const dynamicOpened = dynamicNode?.field_2 === true;
    const dynamicLit = dynamicNode?.field_3 === true;
    const dynamicLightable = dynamicOpened && dynamicNode?.field_3 === false;
    const noClaimable = currentDay === group.order && !!noClaimableDays[String(group.order)];
    let opened;
    let lit;
    let stateKnown;
    let visualState;
    let claimStatus = null;
    let statusSource;
    if (confirmedLit || dynamicLit || noClaimable) {
      opened = true;
      lit = true;
      stateKnown = true;
      visualState = "lit";
      claimStatus = noClaimable ? "confirmed-no-claimable" : null;
      statusSource = noClaimable ? "server-rejection" : confirmedLit ? "persisted" : "authoritative";
    } else if (dynamicLightable) {
      opened = true;
      lit = false;
      stateKnown = true;
      visualState = "lightable";
      statusSource = "authoritative";
    } else if (currentDay != null && group.order > currentDay) {
      opened = false;
      lit = false;
      stateKnown = false;
      visualState = "locked";
      statusSource = "schedule";
    } else if (currentDay != null && group.order === currentDay) {
      opened = confirmedOpened || dynamicOpened ? true : null;
      lit = null;
      stateKnown = false;
      visualState = "claimableUnknown";
      statusSource = confirmedOpened ? "persisted" : dynamicOpened ? "authoritative" : "schedule";
    } else {
      opened = confirmedOpened || dynamicOpened ? true : null;
      lit = null;
      stateKnown = false;
      visualState = "unknown";
      statusSource = confirmedOpened ? "persisted" : dynamicOpened ? "authoritative" : "schedule";
    }
    return {
      id,
      nodeId,
      name: group.name,
      category: group.category,
      explain: group.explain,
      order: group.order,
      chartIndex: group.links.chartIndex,
      rewards: group.rewards.map(itemDto),
      linksRaw: group.linksRaw,
      nodeIds: group.links.nodeIds.map(String),
      visualState,
      opened,
      lit,
      stateKnown,
      claimStatus,
      statusSource,
      ...dynamicNode || dynamicGroup ? {
        raw: {
          node: dynamicNode ? rawConstellationNode(dynamicNode) : null,
          group: dynamicGroup ? rawConstellationGroup(dynamicGroup) : null
        }
      } : {}
    };
  });
  return {
    activityId,
    typeCode: CONSTELLATION_ACTIVITY_TYPE,
    displayName: import_constellation_2026072701.default.displayName,
    serverName: activityMetadata.name || import_constellation_2026072701.default.serverName,
    startTime,
    endTime,
    serverTime,
    catalogVersion: import_constellation_2026072701.default.catalogVersion,
    catalogStatus: "supported",
    rules: import_constellation_2026072701.default.rules,
    currentDay,
    groups,
    ...data ? {
      raw: {
        field1Code: int64String(data.field_1),
        field2Code: int64String(data.field_2),
        field3Code: int64String(data.field_3)
      }
    } : {}
  };
}
async function querySeason() {
  const body = Buffer.from(types.GetSeasonInfoRequest.encode(types.GetSeasonInfoRequest.create({})).finish());
  const { body: replyBody } = await sendMsgAsync("gamepb.seasonpb.SeasonService", "GetSeasonInfo", body);
  return types.GetSeasonInfoReply.decode(replyBody);
}
async function querySolarTerms() {
  const body = Buffer.from(types.GetSolarTermsRequest.encode(types.GetSolarTermsRequest.create({})).finish());
  const { body: replyBody } = await sendMsgAsync("gamepb.solartermspb.SolarTermsService", "GetSolarTerms", body);
  return types.GetSolarTermsReply.decode(replyBody);
}
function findSeasonActivity(seasonReply, typeCode) {
  const activities = Array.isArray(seasonReply?.season_info?.activities) ? seasonReply.season_info.activities : [];
  return activities.find((activity) => int64String(activity?.type) === typeCode) || null;
}
function normalizeSeason(reply) {
  const season = reply?.season_info;
  if (!season) throw new Error("\u5F53\u524D\u8D5B\u5B63\u6570\u636E\u4E3A\u7A7A");
  const rawActivities = Array.isArray(season.activities) ? season.activities : [];
  const constellationActivity = findSeasonActivity(reply, CONSTELLATION_ACTIVITY_TYPE);
  const shopActivity = findSeasonActivity(reply, SHOP_ACTIVITY_TYPE);
  return {
    id: int64String(season.season_id),
    title: bytesToText(season.name),
    statusCode: int64String(season.status),
    field4Code: int64String(season.field_4),
    startTime: int64String(season.begin_time),
    endTime: int64String(season.end_time),
    serverTime: int64String(season.server_time),
    activities: rawActivities.map(activityDto),
    constellationActivity: constellationActivity ? activityDto(constellationActivity) : null,
    shopActivity: shopActivity ? activityDto(shopActivity) : null,
    pass: passDto(season.pass)
  };
}
function normalizeSolarTerms(reply) {
  const serverTime = int64Number(reply?.server_time);
  const terms = (Array.isArray(reply?.terms) ? reply.terms : []).map(solarTermDto).filter(Boolean);
  const currentTerm = terms.find((term) => {
    const start = Number(term.startTime);
    const end = Number(term.endTime);
    return serverTime > 0 && start <= serverTime && serverTime <= end;
  }) || null;
  const configs = Array.isArray(reply?.configs) ? reply.configs : [];
  return {
    serverTime: int64String(reply?.server_time),
    currentTermId: currentTerm?.id || null,
    terms,
    currentConfig: reply?.current_config ? {
      id: int64String(reply.current_config.config_id),
      activityId: int64String(reply.current_config.activity_id),
      rules: textContent(reply.current_config.rules_json),
      field4: parseJsonText(reply.current_config.field_4)
    } : null,
    configs: configs.map((config) => ({
      id: int64String(config.config_id),
      activityId: int64String(config.activity_id),
      rules: textContent(config.rules_json),
      field4: parseJsonText(config.field_4)
    }))
  };
}
function readBagBalances(bagReply, currencyIds) {
  const requestedIds = new Set(currencyIds);
  const balances = new Map(currencyIds.map((id) => [id, 0n]));
  for (const item of getBagItems(bagReply)) {
    const id = int64String(item?.id ?? item?.item_id);
    if (!requestedIds.has(id)) continue;
    const count = BigInt(int64String(item?.count));
    balances.set(id, (balances.get(id) || 0n) + (count > 0n ? count : 0n));
  }
  return new Map(Array.from(balances, ([id, count]) => [id, count.toString()]));
}
function isExplicitlyUnavailableShopStatus(_statusCode) {
  return false;
}
function normalizeShopFromReply(seasonReply, shopActivity, reply, balances) {
  const goods = Array.isArray(reply.data?.catalog?.goods) ? reply.data.catalog.goods : [];
  const currencyIds = Array.from(new Set(goods.map((entry) => int64String(entry?.cost?.item_id)).filter((id) => id !== "0")));
  const balanceKnown = balances !== null;
  const activityId = int64String(reply.activity_id);
  const goodsDtos = goods.map((entry) => {
    const statusCode = int64String(entry.status);
    const costId = int64String(entry?.cost?.item_id);
    const costCount = int64String(entry?.cost?.count);
    const costValid = costId !== "0" && BigInt(costCount) > 0n;
    const exchangeable = costValid && !isExplicitlyUnavailableShopStatus(statusCode);
    const balance = balanceKnown ? BigInt(balances.get(costId) || "0") : 0n;
    const maxExchangeCount = exchangeable && balanceKnown ? (balance / BigInt(costCount)).toString() : "0";
    return {
      id: int64String(entry.goods_id),
      activityId,
      name: bytesToText(entry.name),
      category: bytesToText(entry.category),
      item: itemDto(entry.item),
      cost: itemDto(entry.cost),
      sortOrder: int64String(entry.sort_order),
      resource: parseJsonText(entry.resource_json),
      statusCode,
      owned: entry.owned === true,
      exchangeable,
      soldOut: false,
      balanceKnown,
      maxExchangeCount,
      maxExchangeCountKnown: balanceKnown,
      qualityCode: int64String(entry.field_10),
      field11Code: int64String(entry.field_11)
    };
  });
  const exchangeableCount = goodsDtos.filter((entry) => entry.exchangeable).length;
  const affordableCount = goodsDtos.filter((entry) => entry.exchangeable && (!entry.maxExchangeCountKnown || BigInt(entry.maxExchangeCount) > 0n)).length;
  return {
    activityId,
    name: bytesToText(reply.data?.activity?.name) || bytesToText(shopActivity.name),
    startTime: int64String(shopActivity.begin_time),
    endTime: int64String(shopActivity.end_time),
    serverTime: int64String(seasonReply?.season_info?.server_time),
    balanceKnown,
    currencies: currencyIds.map((id) => ({
      ...itemDto({ item_id: id, count: balanceKnown ? balances.get(id) || "0" : "0" }),
      balance: balanceKnown ? balances.get(id) || "0" : null,
      balanceKnown
    })),
    categories: Array.from(new Set(goods.map((entry) => bytesToText(entry.category)).filter(Boolean))),
    goods: goodsDtos,
    action: {
      supported: true,
      enabled: affordableCount > 0,
      available: affordableCount > 0,
      count: affordableCount,
      availabilityKnown: true,
      ...exchangeableCount === 0 ? { reason: "\u5F53\u524D\u76EE\u5F55\u6CA1\u6709\u660E\u786E\u53EF\u5151\u6362\u7684\u5546\u54C1" } : affordableCount === 0 ? { reason: "\u5F53\u524D\u4F59\u989D\u4E0D\u8DB3\u4EE5\u5151\u6362\u76EE\u5F55\u5546\u54C1" } : {}
    }
  };
}
async function queryShopCatalog(shopActivity) {
  const request = types.QueryActivityRequest.create({
    activity_id: shopActivity.activity_id,
    operate_type: QUERY_SHOP_OPERATE_TYPE
  });
  const body = Buffer.from(types.QueryActivityRequest.encode(request).finish());
  const { body: replyBody } = await sendMsgAsync("gamepb.activitypb.ActivityService", "Operate", body);
  const reply = types.ActivityOperateReply.decode(replyBody);
  if (int64String(reply.activity_id) !== int64String(shopActivity.activity_id)) {
    throw businessError("SHOP_RESPONSE_INVALID", "\u6D3B\u52A8\u5546\u5E97\u67E5\u8BE2\u8FD4\u56DE\u4E86\u4E0D\u5339\u914D\u7684\u6D3B\u52A8 ID");
  }
  if (int64String(reply.operate_type) !== String(QUERY_SHOP_OPERATE_TYPE)) {
    throw businessError("SHOP_RESPONSE_INVALID", `\u6D3B\u52A8\u5546\u5E97\u67E5\u8BE2\u8FD4\u56DE\u4E86\u672A\u77E5\u64CD\u4F5C\u7C7B\u578B: ${int64String(reply.operate_type)}`);
  }
  if (!reply.data?.catalog || !Array.isArray(reply.data.catalog.goods)) {
    throw businessError("SHOP_RESPONSE_INVALID", "\u6D3B\u52A8\u5546\u5E97\u67E5\u8BE2\u56DE\u5305\u7F3A\u5C11\u5546\u54C1\u76EE\u5F55");
  }
  return reply;
}
async function queryShopFromSeason(seasonReply) {
  const shopActivity = findSeasonActivity(seasonReply, SHOP_ACTIVITY_TYPE);
  if (!shopActivity) throw businessError("SHOP_UNAVAILABLE", "\u5F53\u524D\u8D5B\u5B63\u672A\u53D1\u73B0\u6D3B\u52A8\u5546\u5E97");
  const reply = await queryShopCatalog(shopActivity);
  const goods = reply.data.catalog.goods;
  const currencyIds = Array.from(new Set(goods.map((entry) => int64String(entry?.cost?.item_id)).filter((id) => id !== "0")));
  let balances = null;
  try {
    balances = readBagBalances(await getBag(), currencyIds);
  } catch {
  }
  return normalizeShopFromReply(seasonReply, shopActivity, reply, balances);
}
function settledValue(entry) {
  return entry.status === "fulfilled" ? entry.value : null;
}
function settledError(entry) {
  if (entry.status === "fulfilled") return null;
  return String(entry.reason?.message || entry.reason || "\u672A\u77E5\u9519\u8BEF");
}
function buildActions(season, solarTerms, constellation = null, shop = null) {
  const hasPass = !!season?.pass;
  const claimablePassCount = hasPass ? season.pass.nodes.filter((node) => node.claimable).length : 0;
  const hasConstellation = !!season?.constellationActivity;
  const serverTime = int64Number(season?.serverTime);
  const constellationStartTime = int64Number(season?.constellationActivity?.startTime);
  const constellationEndTime = int64Number(season?.constellationActivity?.endTime);
  const constellationActive = hasConstellation && (serverTime <= 0 || constellationStartTime <= 0 || serverTime >= constellationStartTime) && (serverTime <= 0 || constellationEndTime <= 0 || serverTime <= constellationEndTime);
  const groups = Array.isArray(constellation?.groups) ? constellation.groups : [];
  const lightableGroups = groups.filter((group) => group.visualState === "lightable");
  const attemptableGroups = groups.filter((group) => group.visualState === "lightable" || group.visualState === "claimableUnknown");
  const currentGroups = groups.filter((group) => group.order === constellation?.currentDay);
  const availabilityKnown = lightableGroups.length > 0 || currentGroups.length > 0 && currentGroups.every((group) => group.stateKnown);
  const hasClaimableSolar = !!solarTerms?.terms?.some((term) => term.canClaim);
  return {
    claimPass: {
      supported: true,
      enabled: hasPass,
      available: claimablePassCount > 0,
      count: claimablePassCount
    },
    lightConstellation: {
      supported: true,
      enabled: constellationActive && attemptableGroups.length > 0,
      available: lightableGroups.length > 0,
      attemptable: attemptableGroups.length > 0,
      availabilityKnown: !!constellation && constellation.catalogStatus === "supported" && availabilityKnown,
      count: lightableGroups.length,
      attemptableCount: attemptableGroups.length
    },
    claimSolar: { supported: true, enabled: hasClaimableSolar },
    exchange: {
      supported: true,
      enabled: !!shop?.action?.enabled,
      available: !!shop?.action?.available,
      availabilityKnown: !!shop,
      count: Number(shop?.action?.count) || 0,
      ...!shop ? { reason: "\u6D3B\u52A8\u5546\u5E97\u76EE\u5F55\u5F53\u524D\u4E0D\u53EF\u7528" } : shop.action?.reason ? { reason: shop.action.reason } : {}
    }
  };
}
async function getActivityCenterSnapshot(shopOverride = null) {
  const [seasonResult, solarResult] = await Promise.allSettled([querySeason(), querySolarTerms()]);
  const rawSeason = settledValue(seasonResult);
  const season = rawSeason ? normalizeSeason(rawSeason) : null;
  const solarTerms = solarResult.status === "fulfilled" ? normalizeSolarTerms(solarResult.value) : null;
  let shopResult;
  if (shopOverride) {
    shopResult = { status: "fulfilled", value: shopOverride };
  } else if (rawSeason) {
    [shopResult] = await Promise.allSettled([queryShopFromSeason(rawSeason)]);
  } else {
    shopResult = { status: "rejected", reason: new Error("\u8D5B\u5B63\u67E5\u8BE2\u5931\u8D25\uFF0C\u65E0\u6CD5\u53D1\u73B0\u6D3B\u52A8\u5546\u5E97 ID") };
  }
  const shop = settledValue(shopResult);
  const constellationActivity = findSeasonActivity(rawSeason, CONSTELLATION_ACTIVITY_TYPE);
  const constellationIdentity = constellationActivity ? constellationStateIdentity(rawSeason, constellationActivity) : null;
  const constellation = constellationActivity && constellationIdentity ? constellationDto(
    constellationActivity,
    rawSeason?.season_info?.server_time,
    lastConstellationDynamicState.get(stateRecordKey(constellationIdentity)),
    loadMergedConstellationState(rawSeason, constellationActivity)
  ) : null;
  const actions = buildActions(season, solarTerms, constellation, shop);
  return {
    season,
    constellation,
    shop,
    solarTerms,
    capabilities: {
      claimPass: actions.claimPass.supported,
      lightConstellation: actions.lightConstellation.supported,
      claimSolar: actions.claimSolar.supported,
      exchange: actions.exchange.supported
    },
    actions,
    errors: {
      season: settledError(seasonResult),
      shop: settledError(shopResult),
      solarTerms: settledError(solarResult)
    }
  };
}
async function getCurrentSeasonEvent() {
  const seasonReply = await querySeason();
  const season = normalizeSeason(seasonReply);
  const activity = findSeasonActivity(seasonReply, CONSTELLATION_ACTIVITY_TYPE);
  const constellationIdentity = activity ? constellationStateIdentity(seasonReply, activity) : null;
  const constellation = activity && constellationIdentity ? constellationDto(
    activity,
    seasonReply?.season_info?.server_time,
    lastConstellationDynamicState.get(stateRecordKey(constellationIdentity)),
    loadMergedConstellationState(seasonReply, activity)
  ) : null;
  const actions = buildActions(season, null, constellation);
  return { ...season, capabilities: { claimPass: true, lightConstellation: true }, actions };
}
async function getCurrentStarSandShop() {
  return queryShopFromSeason(await querySeason());
}
async function getCurrentSolarTerms() {
  const solarTerms = normalizeSolarTerms(await querySolarTerms());
  const actions = buildActions(null, solarTerms);
  return { ...solarTerms, capabilities: { claimSolar: true }, actions };
}
function serializeMutation(operation) {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(() => void 0, () => void 0);
  return result;
}
async function claimBattlePassRewards() {
  return serializeMutation(async () => {
    const seasonReply = await querySeason();
    const pass = passDto(seasonReply?.season_info?.pass);
    if (!pass) throw new Error("\u670D\u52A1\u7AEF\u672A\u53D1\u73B0\u53EF\u7528\u6E38\u8BB0");
    if (!pass.nodes.some((node) => node.claimable)) {
      throw new Error("\u5F53\u524D\u6CA1\u6709\u53EF\u9886\u53D6\u7684\u6E38\u8BB0\u5956\u52B1");
    }
    const body = Buffer.from(types.ClaimBattlePassRewardsRequest.encode(
      types.ClaimBattlePassRewardsRequest.create({})
    ).finish());
    const { body: replyBody } = await sendMsgAsync(
      "gamepb.seasonpb.SeasonService",
      "ClaimBattlePassRewards",
      body
    );
    const reply = types.ClaimBattlePassRewardsReply.decode(replyBody);
    return {
      rewards: (Array.isArray(reply.rewards) ? reply.rewards : []).map(itemDto),
      field2Codes: (Array.isArray(reply.field_2) ? reply.field_2 : []).map(int64String),
      pass: passDto(reply.pass),
      snapshot: await getActivityCenterSnapshot()
    };
  });
}
async function exchangeStarSandGoods(goodsIdInput, countInput) {
  const goodsId = positiveDecimal(goodsIdInput, "INVALID_SHOP_GOODS_ID", "goodsId");
  const count = positiveDecimal(countInput, "INVALID_EXCHANGE_COUNT", "count");
  return serializeMutation(async () => {
    const seasonReply = await querySeason();
    const shopActivity = findSeasonActivity(seasonReply, SHOP_ACTIVITY_TYPE);
    if (!shopActivity) throw businessError("SHOP_UNAVAILABLE", "\u5F53\u524D\u8D5B\u5B63\u672A\u53D1\u73B0\u6D3B\u52A8\u5546\u5E97");
    const catalogReply = await queryShopCatalog(shopActivity);
    const catalogGoods = catalogReply.data.catalog.goods;
    const rawGoods = catalogGoods.find((entry) => int64String(entry?.goods_id) === goodsId);
    if (!rawGoods) throw businessError("SHOP_GOODS_NOT_FOUND", "\u6D3B\u52A8\u5546\u5E97\u4E2D\u672A\u627E\u5230\u6307\u5B9A\u5546\u54C1");
    const currencyId = int64String(rawGoods?.cost?.item_id);
    const unitCostText = int64String(rawGoods?.cost?.count);
    const unitCost = BigInt(unitCostText);
    if (currencyId === "0" || unitCost <= 0n) {
      throw businessError("SHOP_RESPONSE_INVALID", "\u5546\u54C1\u5151\u6362\u6210\u672C\u65E0\u6548\uFF0C\u8BF7\u5237\u65B0\u5546\u5E97\u540E\u91CD\u8BD5");
    }
    let balances;
    try {
      balances = readBagBalances(await getBag(), [currencyId]);
    } catch {
      throw businessError("SHOP_BALANCE_UNAVAILABLE", "\u65E0\u6CD5\u786E\u8BA4\u5F53\u524D\u661F\u7802\u4F59\u989D\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    }
    const shopBefore = normalizeShopFromReply(seasonReply, shopActivity, catalogReply, balances);
    const normalizedGoods = shopBefore.goods.find((entry) => entry.id === goodsId);
    if (!normalizedGoods) throw businessError("SHOP_GOODS_NOT_FOUND", "\u6D3B\u52A8\u5546\u5E97\u4E2D\u672A\u627E\u5230\u6307\u5B9A\u5546\u54C1");
    if (!normalizedGoods.exchangeable || normalizedGoods.soldOut) {
      throw businessError("SHOP_GOODS_UNAVAILABLE", "\u8BE5\u5546\u54C1\u5F53\u524D\u4E0D\u53EF\u5151\u6362\uFF0C\u8BF7\u5237\u65B0\u5546\u5E97\u540E\u91CD\u8BD5");
    }
    const purchaseCount = BigInt(count);
    const totalCost = unitCost * purchaseCount;
    const balance = BigInt(balances.get(currencyId) || "0");
    if (balance < totalCost) {
      throw businessError("INSUFFICIENT_STAR_SAND", "\u661F\u7802\u4F59\u989D\u4E0D\u8DB3\uFF0C\u65E0\u6CD5\u5B8C\u6210\u672C\u6B21\u5151\u6362");
    }
    const request = types.ExchangeShopRequest.create({
      activity_id: shopActivity.activity_id,
      operate_type: EXCHANGE_SHOP_OPERATE_TYPE,
      exchange_shop_operate: {
        goods_id: goodsId,
        count
      }
    });
    const body = Buffer.from(types.ExchangeShopRequest.encode(request).finish());
    const { body: replyBody } = await sendMsgAsync("gamepb.activitypb.ActivityService", "Operate", body);
    const reply = types.ActivityOperateReply.decode(replyBody);
    if (int64String(reply.activity_id) !== int64String(shopActivity.activity_id)) {
      throw businessError("SHOP_RESPONSE_INVALID", "\u6D3B\u52A8\u5546\u5E97\u5151\u6362\u8FD4\u56DE\u4E86\u4E0D\u5339\u914D\u7684\u6D3B\u52A8 ID");
    }
    if (int64String(reply.operate_type) !== String(EXCHANGE_SHOP_OPERATE_TYPE)) {
      throw businessError("SHOP_RESPONSE_INVALID", `\u6D3B\u52A8\u5546\u5E97\u5151\u6362\u8FD4\u56DE\u4E86\u672A\u77E5\u64CD\u4F5C\u7C7B\u578B: ${int64String(reply.operate_type)}`);
    }
    if (!reply.data?.catalog || !Array.isArray(reply.data.catalog.goods)) {
      throw businessError("SHOP_RESPONSE_INVALID", "\u6D3B\u52A8\u5546\u5E97\u5151\u6362\u56DE\u5305\u7F3A\u5C11\u6700\u65B0\u5546\u54C1\u76EE\u5F55");
    }
    const responseCurrencyIds = Array.from(new Set(reply.data.catalog.goods.map((entry) => int64String(entry?.cost?.item_id)).filter((id) => id !== "0")));
    let latestBalances = null;
    try {
      latestBalances = readBagBalances(await getBag(), responseCurrencyIds);
    } catch {
    }
    const shop = normalizeShopFromReply(seasonReply, shopActivity, reply, latestBalances);
    const snapshot = await getActivityCenterSnapshot(shop);
    const unitItemCount = BigInt(int64String(rawGoods?.item?.count));
    const totalItemCount = (unitItemCount > 0n ? unitItemCount * purchaseCount : 0n).toString();
    const receivedItem = itemDto({
      item_id: rawGoods?.item?.item_id,
      count: totalItemCount
    });
    const rewards = receivedItem.id !== "0" && totalItemCount !== "0" ? [receivedItem] : [];
    return {
      purchaseCount: count,
      totalItemCount,
      totalCost: totalCost.toString(),
      rewards,
      receivedItems: rewards,
      message: `\u5151\u6362\u6210\u529F\uFF0C\u5171\u6D88\u8017 ${totalCost.toString()} ${normalizedGoods.cost.name || "\u661F\u7802"}`,
      shop,
      snapshot
    };
  });
}
async function lightConstellation() {
  return serializeMutation(async () => {
    const seasonReply = await querySeason();
    const activity = findSeasonActivity(seasonReply, CONSTELLATION_ACTIVITY_TYPE);
    if (!activity) throw new Error("\u670D\u52A1\u7AEF\u672A\u53D1\u73B0\u661F\u5EA7\u6D3B\u52A8");
    const identity = constellationStateIdentity(seasonReply, activity);
    const stateKey = stateRecordKey(identity);
    const serverTime = int64String(seasonReply?.season_info?.server_time);
    const startTime = int64Number(activity.begin_time);
    const serverTimeNumber = int64Number(serverTime);
    const currentDay = constellationDayFromBeijingMidnight(startTime, serverTimeNumber) ?? 0;
    const activityEndTime = int64Number(activity.end_time);
    const activityActive = serverTimeNumber > 0 && startTime > 0 && serverTimeNumber >= startTime && (activityEndTime <= 0 || serverTimeNumber <= activityEndTime);
    const request = types.OperateConstellationRequest.create({
      activity_id: activity.activity_id,
      operate_type: LIGHT_CONSTELLATION_OPERATE_TYPE,
      field_119: {}
    });
    const body = Buffer.from(types.OperateConstellationRequest.encode(request).finish());
    let replyBody;
    try {
      ({ body: replyBody } = await sendMsgAsync(
        "gamepb.activitypb.ActivityService",
        "Operate",
        body,
        { expectedErrorCodes: [1034038] }
      ));
    } catch (error) {
      if (!(error instanceof GatewayError) || error.code !== 1034038 || !activityActive || currentDay < 1 || currentDay > 28) {
        throw error;
      }
      const rejectionState = stateWithNoClaimableDay(identity, currentDay, serverTime);
      const mergedState2 = mergeConstellationStates(
        identity,
        loadMergedConstellationState(seasonReply, activity),
        rejectionState
      );
      lastConstellationState.set(stateKey, mergedState2);
      let persistenceWarning2;
      try {
        lastConstellationState.set(stateKey, persistConstellationState(mergedState2, identity));
      } catch (persistenceError) {
        persistenceWarning2 = String(persistenceError?.message || persistenceError || "\u89C2\u661F\u72B6\u6001\u6301\u4E45\u5316\u5931\u8D25");
      }
      const snapshot2 = await getActivityCenterSnapshot();
      return {
        outcome: "nothingToClaim",
        noClaimable: true,
        message: "\u4ECA\u65E5\u661F\u5BBF\u5956\u52B1\u5DF2\u7ECF\u9886\u53D6\uFF0C\u65E0\u9700\u91CD\u590D\u64CD\u4F5C",
        snapshot: snapshot2,
        ...persistenceWarning2 ? { persistenceWarning: persistenceWarning2 } : {}
      };
    }
    const reply = types.ActivityOperateReply.decode(replyBody);
    if (int64String(reply.activity_id) !== identity.activityId) {
      throw new Error("\u661F\u5EA7\u64CD\u4F5C\u8FD4\u56DE\u4E86\u4E0D\u5339\u914D\u7684\u6D3B\u52A8 ID");
    }
    if (int64String(reply.operate_type) !== String(LIGHT_CONSTELLATION_OPERATE_TYPE)) {
      throw new Error(`\u661F\u5EA7\u64CD\u4F5C\u8FD4\u56DE\u4E86\u672A\u77E5\u64CD\u4F5C\u7C7B\u578B: ${int64String(reply.operate_type)}`);
    }
    const constellationState = reply.data?.constellation;
    if (!constellationState) throw new Error("\u661F\u5EA7\u64CD\u4F5C\u6210\u529F\u4F46\u56DE\u5305\u7F3A\u5C11\u52A8\u6001\u72B6\u6001");
    lastConstellationDynamicState.set(stateKey, constellationState);
    const mergedState = mergeConstellationStates(
      identity,
      loadMergedConstellationState(seasonReply, activity),
      stateFromDynamicNodes(identity, constellationState.nodes)
    );
    lastConstellationState.set(stateKey, mergedState);
    let persistenceWarning;
    try {
      lastConstellationState.set(stateKey, persistConstellationState(mergedState, identity));
    } catch (persistenceError) {
      persistenceWarning = String(persistenceError?.message || persistenceError || "\u89C2\u661F\u72B6\u6001\u6301\u4E45\u5316\u5931\u8D25");
    }
    const snapshot = await getActivityCenterSnapshot();
    return {
      outcome: "lighted",
      rewards: [],
      activity: reply.data?.activity ? activityDto(reply.data.activity) : activityDto(activity),
      constellation: snapshot.constellation,
      snapshot,
      ...persistenceWarning ? { persistenceWarning } : {}
    };
  });
}
async function claimSolarTerm(termId) {
  return serializeMutation(async () => {
    if (!/^[1-9]\d*$/.test(termId)) throw new Error("termId \u5FC5\u987B\u662F\u6B63\u5341\u8FDB\u5236\u6574\u6570");
    const solarReply = await querySolarTerms();
    const term = (Array.isArray(solarReply?.terms) ? solarReply.terms : []).find((entry) => int64String(entry?.term_id) === termId);
    if (!term) throw new Error("\u670D\u52A1\u7AEF\u672A\u53D1\u73B0\u6307\u5B9A\u8282\u4EE4");
    if (int64String(term.status) !== "2") throw new Error("\u6307\u5B9A\u8282\u4EE4\u5F53\u524D\u4E0D\u53EF\u9886\u53D6");
    const body = Buffer.from(types.ClaimSolarTermsRequest.encode(
      types.ClaimSolarTermsRequest.create({ term_id: term.term_id })
    ).finish());
    const { body: replyBody } = await sendMsgAsync(
      "gamepb.solartermspb.SolarTermsService",
      "ClaimSolarTerms",
      body
    );
    const reply = types.ClaimSolarTermsReply.decode(replyBody);
    return {
      rewards: (Array.isArray(reply.rewards) ? reply.rewards : []).map(itemDto),
      term: solarTermDto(reply.term),
      snapshot: await getActivityCenterSnapshot()
    };
  });
}
module.exports = {
  getActivityCenterSnapshot,
  getCurrentSeasonEvent,
  getCurrentStarSandShop,
  getCurrentSolarTerms,
  claimBattlePassRewards,
  exchangeStarSandGoods,
  lightConstellation,
  claimSolarTerm
};
