const fetch = require('node-fetch');
const { version: packageVersion } = require('../../package.json');
const { createModuleLogger } = require('./logger');
const { createScheduler } = require('./scheduler');

const logger = createModuleLogger('version-checker');
const TAGS_API_URL = 'https://api.github.com/repos/caoxicheng/qq-farm-automation-bot/tags?per_page=100';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

function parseVersionTag(value, options = {}) {
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
    const stage = match[2] || 'stable';
    return {
        tag: `v${match[1]}${stage === 'stable' ? '' : `-${stage}.${Number(match[3])}`}`,
        date: Number(match[1]),
        stage,
        sequence: stage === 'stable' ? 0 : Number(match[3]),
    };
}

function compareVersions(left, right) {
    if (left.date !== right.date) return left.date - right.date;
    const stageRank = { beta: 0, rc: 1, stable: 2 };
    if (left.stage !== right.stage) return stageRank[left.stage] - stageRank[right.stage];
    return left.sequence - right.sequence;
}

function createVersionChecker(options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const currentVersion = String(options.currentVersion || packageVersion);
    const current = parseVersionTag(currentVersion);
    if (!current) throw new Error(`无效的当前版本号: ${currentVersion}`);

    const scheduler = options.scheduler || createScheduler('version_checker');
    const apiUrl = options.apiUrl || TAGS_API_URL;
    const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
    let inFlight = null;
    let state = {
        currentVersion,
        latestTag: null,
        updateAvailable: false,
        checkedAt: 0,
    };

    async function checkNow() {
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
                    .map(item => parseVersionTag(item && item.name, { requirePrefix: true }))
                    .filter(Boolean);
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
                logger.warn('GitHub 版本检查失败', { error: error.message });
                return { ...state };
            } finally {
                clearTimeout(timer);
                inFlight = null;
            }
        })();
        return inFlight;
    }

    function start() {
        const initialCheck = checkNow().catch(() => getStatus());
        scheduler.setIntervalTask('github_version_check', CHECK_INTERVAL_MS, checkNow, { preventOverlap: true });
        return initialCheck;
    }

    function stop() {
        scheduler.clearAll();
    }

    function getStatus() {
        return { ...state };
    }

    return { checkNow, getStatus, start, stop };
}

const versionChecker = createVersionChecker();

module.exports = {
    CHECK_INTERVAL_MS,
    compareVersions,
    createVersionChecker,
    parseVersionTag,
    versionChecker,
};
