const assert = require('node:assert/strict');
const test = require('node:test');
const { registerActivityRoutes } = require('../src/controllers/admin-routes/activity');
const { registerGameplayRoutes } = require('../src/controllers/admin-routes/gameplay');
const { registerLogRoutes } = require('../src/controllers/admin-routes/logs');
const { registerQrRoutes } = require('../src/controllers/admin-routes/qr');
const { registerUserRoutes } = require('../src/controllers/admin-routes/users');
const { OperationTimeoutError } = require('../src/utils/request-coordination');

function createAppRecorder() {
    const routes = [];
    const handlers = new Map();
    const app = {};
    for (const method of ['get', 'post', 'delete']) {
        app[method] = (path, ...routeHandlers) => {
            routes.push(`${method.toUpperCase()} ${path}`);
            handlers.set(`${method.toUpperCase()} ${path}`, routeHandlers[routeHandlers.length - 1]);
            return app;
        };
    }
    return { app, handlers, routes };
}

const middleware = (_req, _res, next) => next?.();
const accessAllowed = () => true;
const getAccountId = () => 'account-1';
const handleApiError = () => undefined;

test('农场与好友路由按原有顺序完整注册', () => {
    const { app, routes } = createAppRecorder();

    registerGameplayRoutes({
        addOrUpdateAccount: value => value,
        adminLogger: { info() {}, warn() {} },
        app,
        authRequired: middleware,
        checkAccountAccess: accessAllowed,
        getAccountId,
        handleApiError,
        provider: {},
        resolveAccountId: value => String(value || ''),
        store: {},
        wxLoginAdapter: {},
    });

    assert.deepEqual(routes, [
        'GET /api/status',
        'GET /api/diamond',
        'POST /api/automation',
        'POST /api/fertilizer/buy',
        'POST /api/fertilizer/check-and-buy',
        'GET /api/lands',
        'GET /api/friends',
        'POST /api/friends/clear-cache',
        'GET /api/interact-records',
        'GET /api/friend/:gid/lands',
        'POST /api/friend/:gid/op',
        'GET /api/friend-blacklist',
        'POST /api/friend-blacklist/toggle',
        'GET /api/friend-known-gids',
        'POST /api/friend-known-gids',
        'POST /api/friend-known-gids/remove',
        'POST /api/friend-known-gids/batch-add',
        'POST /api/friend-known-gids/batch-remove',
        'GET /api/plant-blacklist',
        'POST /api/plant-blacklist',
        'DELETE /api/plant-blacklist/:seedId',
        'POST /api/plant-blacklist/batch',
        'DELETE /api/plant-blacklist',
        'GET /api/seeds',
        'GET /api/bag',
        'POST /api/bag/use',
        'POST /api/bag/sell',
        'GET /api/bag/seeds',
        'GET /api/daily-gifts',
        'POST /api/accounts/:id/start',
        'POST /api/accounts/:id/stop',
        'POST /api/farm/operate',
        'GET /api/analytics',
    ]);
});

test('用户、日志与二维码路由完整注册', () => {
    const userRecorder = createAppRecorder();
    registerUserRoutes({
        adminRequired: middleware,
        app: userRecorder.app,
        authRequired: middleware,
        disconnectTokenSockets() {},
        store: {},
        tokens: new Set(),
        tokenUserMap: new Map(),
        userStore: {},
    });
    assert.deepEqual(userRecorder.routes, [
        'GET /api/admin/cards',
        'POST /api/admin/cards',
        'POST /api/admin/cards/batch-delete',
        'POST /api/admin/cards/:code',
        'DELETE /api/admin/cards/:code',
        'GET /api/card-claim/status',
        'POST /api/admin/card-claim/status',
        'POST /api/card-claim/claim',
        'GET /api/admin/card-claim/records',
        'GET /api/admin/users',
        'GET /api/admin/users-with-password',
        'POST /api/admin/users/:username',
        'POST /api/admin/users/:username/edit',
        'DELETE /api/admin/users/:username',
        'POST /api/admin/users/:username/renew',
        'GET /api/user/me',
        'POST /api/user/wxlogin-config',
        'GET /api/user/wxlogin-config',
    ]);

    const logRecorder = createAppRecorder();
    registerLogRoutes({
        app: logRecorder.app,
        checkAccountAccess: accessAllowed,
        getAccessibleAccountIds: () => [],
        getAccountId,
        getSocketServer: () => null,
        handleApiError,
        provider: {},
        resolveAccountId: value => String(value || ''),
    });
    assert.deepEqual(logRecorder.routes, ['GET /api/logs', 'DELETE /api/logs']);

    const qrRecorder = createAppRecorder();
    registerQrRoutes(qrRecorder.app);
    assert.deepEqual(qrRecorder.routes, ['POST /api/qr/create', 'POST /api/qr/check']);
});

test('微信账号启动会等待新 Code 持久化后再创建 Worker', async () => {
    const { app, handlers } = createAppRecorder();
    const events = [];
    let finishRefresh;
    const refreshResult = new Promise(resolve => {
        finishRefresh = resolve;
    });

    registerGameplayRoutes({
        addOrUpdateAccount: (value) => events.push(['save', value]),
        adminLogger: { info() {}, warn() {} },
        app,
        authRequired: middleware,
        checkAccountAccess: accessAllowed,
        getAccountId,
        handleApiError,
        provider: {
            getAccounts: () => ({ accounts: [{ id: 'account-1', platform: 'wx', wxid: 'wx-user' }] }),
            startAccount: (id) => {
                events.push(['start', id]);
                return true;
            },
        },
        resolveAccountId: value => String(value || ''),
        store: {},
        wxLoginAdapter: {
            getFarmCode: () => refreshResult,
        },
    });

    const handler = handlers.get('POST /api/accounts/:id/start');
    const response = {
        payload: null,
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        },
    };
    const request = handler({ params: { id: 'account-1' } }, response);

    await Promise.resolve();
    assert.deepEqual(events, []);

    finishRefresh({ Success: true, Data: { code: 'fresh-code' } });
    await request;

    assert.deepEqual(events, [
        ['save', { id: 'account-1', code: 'fresh-code' }],
        ['start', 'account-1'],
    ]);
    assert.deepEqual(response.payload, { ok: true });
});

test('微信 Code 刷新超时时返回可重试错误且不创建 Worker', async () => {
    const { app, handlers } = createAppRecorder();
    let startCalls = 0;

    registerGameplayRoutes({
        addOrUpdateAccount: value => value,
        adminLogger: { info() {}, warn() {} },
        app,
        authRequired: middleware,
        checkAccountAccess: accessAllowed,
        getAccountId,
        handleApiError,
        provider: {
            getAccounts: () => ({ accounts: [{ id: 'account-1', platform: 'wx', wxid: 'wx-user' }] }),
            startAccount: () => {
                startCalls += 1;
                return true;
            },
        },
        resolveAccountId: value => String(value || ''),
        store: {},
        wxLoginAdapter: {
            getFarmCode: async () => { throw new OperationTimeoutError('微信 Code 刷新超时'); },
        },
    });

    const response = {
        payload: null,
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        },
    };
    await handlers.get('POST /api/accounts/:id/start')({ params: { id: 'account-1' } }, response);

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.payload, { ok: false, error: '微信 Code 刷新超时，请稍后重试' });
    assert.equal(startCalls, 0);
});

test('活动路由只保留活动中心操作，不再暴露神秘商人手动页面接口', () => {
    const { app, routes } = createAppRecorder();
    registerActivityRoutes({
        app,
        provider: {},
        getAccountId,
        canAccessAccount: accessAllowed,
    });

    assert.deepEqual(routes, [
        'GET /api/activity-center/snapshot',
        'GET /api/activity-center/season',
        'GET /api/activity-center/shop',
        'GET /api/activity-center/solar-terms',
        'GET /api/activity-center/qingmei',
        'POST /api/activity-center/pass/claim',
        'POST /api/activity-center/constellation/light',
        'POST /api/activity-center/shop/exchange',
        'POST /api/activity-center/solar-terms/:termId/claim',
        'POST /api/activity-center/qingmei/daily-seed/claim',
        'POST /api/activity-center/qingmei/brew/start',
        'POST /api/activity-center/qingmei/brew/continue',
        'POST /api/activity-center/qingmei/brew/settle',
    ]);
    assert.equal(routes.some(route => route.includes('mystery-shop')), false);
});

export {};
