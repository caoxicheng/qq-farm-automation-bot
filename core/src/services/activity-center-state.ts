import crypto from 'node:crypto';
import process from 'node:process';
import { getDataFile } from '../config/runtime-paths';
import { readJsonFile, writeJsonFileAtomic } from './json-db';
import { asRecord, recordArray } from './service-boundaries';

export interface ConstellationIdentity {
  seasonId: string;
  activityId: string;
  catalogVersion: number;
}

export interface NoClaimableDayObservation {
  observedAt: string;
  serverTime: string;
}

export interface ConstellationState extends ConstellationIdentity {
  confirmedOpenedNodeIds: string[];
  confirmedLitNodeIds: string[];
  noClaimableDays: Record<string, NoClaimableDayObservation>;
}

interface StateFile {
  version: number;
  records: Record<string, unknown>;
}

interface StateFileOptions {
  filePath?: string;
}
const STATE_FILE_VERSION = 1;
const STATE_FILE_PREFIX = "activity-center-state";
function normalizeId(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? text : "";
}
function normalizeCatalogVersion(value: unknown): number {
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : 0;
}
function normalizeIdentity(identity: unknown): ConstellationIdentity {
  const source = asRecord(identity);
  return {
    seasonId: normalizeId(source.seasonId),
    activityId: normalizeId(source.activityId),
    catalogVersion: normalizeCatalogVersion(source.catalogVersion)
  };
}
function createEmptyConstellationState(identity: unknown): ConstellationState {
  return {
    ...normalizeIdentity(identity),
    confirmedOpenedNodeIds: [],
    confirmedLitNodeIds: [],
    noClaimableDays: {}
  };
}
function normalizeNodeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(normalizeId).filter(Boolean))).sort((left, right) => {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  });
}
function normalizeNoClaimableDays(value: unknown): Record<string, NoClaimableDayObservation> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, NoClaimableDayObservation> = {};
  for (const [rawDay, rawObservation] of Object.entries(value)) {
    const day = Number(rawDay);
    if (!Number.isSafeInteger(day) || day < 1 || day > 28) continue;
    if (!rawObservation || typeof rawObservation !== "object" || Array.isArray(rawObservation)) continue;
    const observation = asRecord(rawObservation);
    const observedAt = String(observation.observedAt ?? "").trim();
    const serverTime = normalizeId(observation.serverTime);
    if (!observedAt || !serverTime) continue;
    normalized[String(day)] = { observedAt, serverTime };
  }
  return normalized;
}
function normalizeConstellationState(value: unknown, identity: unknown): ConstellationState {
  const expected = normalizeIdentity(identity);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createEmptyConstellationState(expected);
  }
  const source = asRecord(value);
  const actual = normalizeIdentity(source);
  if (actual.seasonId !== expected.seasonId || actual.activityId !== expected.activityId || actual.catalogVersion !== expected.catalogVersion) {
    return createEmptyConstellationState(expected);
  }
  return {
    ...expected,
    confirmedOpenedNodeIds: normalizeNodeIds(source.confirmedOpenedNodeIds),
    confirmedLitNodeIds: normalizeNodeIds(source.confirmedLitNodeIds),
    noClaimableDays: normalizeNoClaimableDays(source.noClaimableDays)
  };
}
function mergeConstellationStates(identity: unknown, ...states: unknown[]): ConstellationState {
  const expected = normalizeIdentity(identity);
  const opened = new Set<string>();
  const lit = new Set<string>();
  const noClaimableDays: Record<string, NoClaimableDayObservation> = {};
  for (const stateValue of states) {
    const state = normalizeConstellationState(stateValue, expected);
    state.confirmedOpenedNodeIds.forEach((id) => opened.add(id));
    state.confirmedLitNodeIds.forEach((id) => {
      lit.add(id);
      opened.add(id);
    });
    for (const [day, observation] of Object.entries(state.noClaimableDays)) {
      const existing = noClaimableDays[day];
      if (!existing || BigInt(observation.serverTime) >= BigInt(existing.serverTime)) {
        noClaimableDays[day] = observation;
      }
    }
  }
  return {
    ...expected,
    confirmedOpenedNodeIds: normalizeNodeIds(Array.from(opened)),
    confirmedLitNodeIds: normalizeNodeIds(Array.from(lit)),
    noClaimableDays
  };
}
function stateRecordKey(identity: unknown): string {
  const normalized = normalizeIdentity(identity);
  return `${normalized.seasonId}:${normalized.activityId}:v${normalized.catalogVersion}`;
}
function resolveAccountId(accountId: unknown): string {
  return String(accountId ?? process.env.FARM_ACCOUNT_ID ?? "").trim() || "default";
}
function safeAccountFileToken(accountId: unknown): string {
  return crypto.createHash("sha256").update(resolveAccountId(accountId), "utf8").digest("hex");
}
function getActivityCenterStateFile(accountId: unknown, options: StateFileOptions = {}): string {
  if (options.filePath) return options.filePath;
  return getDataFile(`${STATE_FILE_PREFIX}-${safeAccountFileToken(accountId)}.json`);
}
function emptyStateFile(): StateFile {
  return { version: STATE_FILE_VERSION, records: {} };
}
function normalizeStateFile(value: unknown): StateFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyStateFile();
  const source = asRecord(value);
  if (Number(source.version) !== STATE_FILE_VERSION || !source.records || typeof source.records !== "object" || Array.isArray(source.records)) {
    return emptyStateFile();
  }
  return { version: STATE_FILE_VERSION, records: asRecord(source.records) };
}
function loadConstellationState(identity: unknown, accountId?: unknown, options: StateFileOptions = {}): ConstellationState {
  const file = normalizeStateFile(readJsonFile(
    getActivityCenterStateFile(accountId, options),
    emptyStateFile
  ));
  return normalizeConstellationState(file.records[stateRecordKey(identity)], identity);
}
function persistConstellationState(
  stateValue: unknown,
  identity: unknown,
  accountId?: unknown,
  options: StateFileOptions = {},
): ConstellationState {
  const filePath = getActivityCenterStateFile(accountId, options);
  const file = normalizeStateFile(readJsonFile(filePath, emptyStateFile));
  const key = stateRecordKey(identity);
  const merged = mergeConstellationStates(identity, file.records[key], stateValue);
  file.records[key] = merged;
  writeJsonFileAtomic(filePath, file);
  return merged;
}
function stateFromDynamicNodes(identity: unknown, nodes: unknown): ConstellationState {
  const opened: string[] = [];
  const lit: string[] = [];
  if (Array.isArray(nodes)) {
    for (const nodeValue of recordArray(nodes)) {
      const node = asRecord(nodeValue);
      const id = normalizeId(node.node_id ?? node.nodeId ?? node.id);
      if (!id) continue;
      if (node?.field_2 === true || node?.field2 === true) opened.push(id);
      if (node?.field_3 === true || node?.field3 === true) {
        opened.push(id);
        lit.push(id);
      }
    }
  }
  return mergeConstellationStates(identity, {
    ...normalizeIdentity(identity),
    confirmedOpenedNodeIds: opened,
    confirmedLitNodeIds: lit,
    noClaimableDays: {}
  });
}
function stateWithNoClaimableDay(
  identity: unknown,
  day: unknown,
  serverTime: unknown,
  observedAt = new Date().toISOString(),
): ConstellationState {
  const normalizedDay = Number(day);
  const dayState = createEmptyConstellationState(identity);
  if (Number.isSafeInteger(normalizedDay) && normalizedDay >= 1 && normalizedDay <= 28) {
    dayState.noClaimableDays[String(normalizedDay)] = {
      observedAt: String(observedAt),
      serverTime: normalizeId(serverTime)
    };
  }
  return normalizeConstellationState(dayState, identity);
}
export {
  createEmptyConstellationState,
  getActivityCenterStateFile,
  loadConstellationState,
  mergeConstellationStates,
  normalizeConstellationState,
  persistConstellationState,
  safeAccountFileToken,
  STATE_FILE_VERSION,
  stateFromDynamicNodes,
  stateRecordKey,
  stateWithNoClaimableDay
};
