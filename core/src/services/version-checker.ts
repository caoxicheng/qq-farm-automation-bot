import * as fs from 'node:fs';
import { getCorePackagePath } from '../config/runtime-paths';
import { createModuleLogger } from './logger';
import type { Scheduler } from './scheduler';
import { createScheduler } from './scheduler';

type VersionStage = 'beta' | 'rc' | 'stable';

export interface ParsedVersion {
    tag: string;
    date: number;
    stage: VersionStage;
    sequence: number;
}

export interface VersionStatus {
    currentVersion: string;
    latestTag: string | null;
    updateAvailable: boolean;
    checkedAt: number;
}

interface FetchResponse {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}

type FetchImplementation = (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchResponse>;

export interface VersionCheckerOptions {
    fetchImpl?: FetchImplementation;
    currentVersion?: string;
    scheduler?: Scheduler;
    apiUrl?: string;
    timeoutMs?: number;
}

export interface VersionChecker {
    checkNow: () => Promise<VersionStatus>;
    getStatus: () => VersionStatus;
    start: () => Promise<VersionStatus>;
    stop: () => void;
}

const fetch = require('node-fetch') as FetchImplementation;
const packageData = JSON.parse(fs.readFileSync(getCorePackagePath(), 'utf8')) as { version?: unknown };
const packageVersion = String(packageData.version || '');
const logger = createModuleLogger('version-checker');
const TAGS_API_URL = 'https://api.github.com/repos/caoxicheng/qq-farm-automation-bot/tags?per_page=100';

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

export function parseVersionTag(value: unknown, options: { requirePrefix?: boolean } = {}): ParsedVersion | null {
    const pattern = options.requirePrefix
        ? /^v(\d{8})(?:-(beta|rc)\.(\d+))?$/
        : /^v?(\d{8})(?:-(beta|rc)\.(\d+))?$/;
    const match = pattern.exec(String(value || '').trim());
    if (!match) return null;
    const year = Number(match[1].slice(0, 4));
    const month = Number(match[1].slice(4, 6));
    const day = Number(match[1].slice(6, 8));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return null;
    }
    const stage: VersionStage = match[2] === 'beta' || match[2] === 'rc' ? match[2] : 'stable';
    return {
        tag: `v${match[1]}${stage === 'stable' ? '' : `-${stage}.${Number(match[3])}`}`,
        date: Number(match[1]),
        stage,
        sequence: stage === 'stable' ? 0 : Number(match[3]),
    };
}

export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
    if (left.date !== right.date) return left.date - right.date;
    const stageRank: Record<VersionStage, number> = { beta: 0, rc: 1, stable: 2 };
    if (left.stage !== right.stage) return stageRank[left.stage] - stageRank[right.stage];
    return left.sequence - right.sequence;
}

export function createVersionChecker(options: VersionCheckerOptions = {}): VersionChecker {
    const fetchImpl = options.fetchImpl || fetch;
    const currentVersion = String(options.currentVersion || packageVersion);
    const parsedCurrent = parseVersionTag(currentVersion);
    if (!parsedCurrent) throw new Error(`无效的当前版本号: ${currentVersion}`);
    const current: ParsedVersion = parsedCurrent;

    const scheduler = options.scheduler || createScheduler('version_checker');
    const apiUrl = options.apiUrl || TAGS_API_URL;
    const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
    let inFlight: Promise<VersionStatus> | null = null;
    let state: VersionStatus = {
        currentVersion,
        latestTag: null,
        updateAvailable: false,
        checkedAt: 0,
    };

    async function checkNow(): Promise<VersionStatus> {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetchImpl(apiUrl, {
                    headers: {
                        Accept: 'application/vnd.github+json',
                        'User-Agent': 'qq-farm-automation-bot-version-checker',
                    },
                    signal: controller.signal,
                });
                if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
                const body = await response.json();
                if (!Array.isArray(body)) throw new Error('GitHub Tags 响应格式无效');
                const versions = body
                    .map((item) => {
                        const name = item && typeof item === 'object' && 'name' in item ? item.name : '';
                        return parseVersionTag(name, { requirePrefix: true });
                    })
                    .filter((version): version is ParsedVersion => Boolean(version));
                const latest = versions.sort(compareVersions).at(-1);
                if (!latest) throw new Error('GitHub Tags 中没有有效版本');
                state = {
                    currentVersion,
                    latestTag: latest.tag,
                    updateAvailable: compareVersions(latest, current) > 0,
                    checkedAt: Date.now(),
                };
                if (state.updateAvailable) {
                    logger.info('发现新版本', { currentVersion: current.tag, latestTag: latest.tag });
                }
                return { ...state };
            } catch (error) {
                logger.warn('GitHub 版本检查失败', { error: errorMessage(error) });
                return { ...state };
            } finally {
                clearTimeout(timer);
                inFlight = null;
            }
        })();
        return inFlight;
    }

    function start(): Promise<VersionStatus> {
        const initialCheck = checkNow().catch(() => getStatus());
        scheduler.setIntervalTask('github_version_check', CHECK_INTERVAL_MS, checkNow, { preventOverlap: true });
        return initialCheck;
    }

    function stop(): void {
        scheduler.clearAll();
    }

    function getStatus(): VersionStatus {
        return { ...state };
    }

    return { checkNow, getStatus, start, stop };
}

export const versionChecker = createVersionChecker();
