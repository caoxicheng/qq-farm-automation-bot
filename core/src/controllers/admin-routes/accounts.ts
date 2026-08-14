import type { Express, Request } from 'express';
import type { DataProvider } from '../../runtime/data-provider';

type DynamicRecord = Record<string, any>;

interface AccountRouteOptions {
    addOrUpdateAccount: (account: DynamicRecord) => DynamicRecord;
    app: Express;
    checkAccountAccess: (request: Request, accountId: unknown) => boolean;
    deleteAccount: (accountId: unknown) => DynamicRecord;
    findAccountByRef: (accounts: unknown, accountRef: unknown) => DynamicRecord | null;
    getAccessibleAccountIds: (request: Request) => unknown[];
    getAccountList: (username?: string | null) => DynamicRecord[];
    provider: DataProvider;
    resolveAccountId: (accountRef: unknown) => string;
    userStore: DynamicRecord;
    wxLoginAdapter: DynamicRecord;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

function registerAccountRoutes(options: AccountRouteOptions): void {
    const {
        addOrUpdateAccount,
        app,
        checkAccountAccess,
        deleteAccount,
        findAccountByRef,
        getAccessibleAccountIds,
        getAccountList,
        provider,
        resolveAccountId: resolveAccId,
        userStore,
        wxLoginAdapter,
    } = options;

    // API: 账号管理
    app.get('/api/accounts', (req, res) => {
        try {
            const currentUser = req.currentUser;
            let data;

            if (currentUser) {
                // 管理员可以看到所有账号，普通用户只能看到自己的账号
                const allAccounts = provider.getAccounts();
                if (currentUser.role === 'admin') {
                    data = allAccounts;
                } else {
                    data = {
                        ...allAccounts,
                        accounts: allAccounts.accounts.filter((a: DynamicRecord) => a.username === currentUser.username)
                    };
                }
            } else {
                // 未登录用户返回空列表
                data = { accounts: [], nextId: 1 };
            }

            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // API: 更新账号备注（兼容旧接口）
    app.post('/api/account/remark', (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const accountList = getAccountList();
            const target = findAccountByRef(accountList, rawRef);
            if (!target || !target.id) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }

            const remark = String(body.remark !== undefined ? body.remark : body.name || '').trim();
            if (!remark) {
                return res.status(400).json({ ok: false, error: 'Missing remark' });
            }

            const accountId = String(target.id);
            const data = addOrUpdateAccount({ id: accountId, name: remark });
            if (provider && typeof provider.setRuntimeAccountName === 'function') {
                provider.setRuntimeAccountName(accountId, remark);
            }
            if (provider && provider.addAccountLog) {
                provider.addAccountLog('update', `更新账号备注: ${remark}`, accountId, remark);
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    app.post('/api/accounts', async (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const currentUser = req.currentUser;
            const isUpdate = !!body.id;

            // 检查权限：普通用户只能更新自己的账号
            if (isUpdate && currentUser && currentUser.role !== 'admin') {
                if (!checkAccountAccess(req, resolveAccId(body.id))) {
                    return res.status(403).json({ ok: false, error: '无权访问此账号' });
                }
            }

            // 检查额度：新增账号时检查用户额度限制
            if (!isUpdate && currentUser && currentUser.role !== 'admin') {
                const userAccounts = getAccountList(currentUser.username);
                const currentCount = userAccounts.length;
                const accountLimit = currentUser.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2;
                
                if (currentCount >= accountLimit) {
                    return res.status(403).json({ 
                        ok: false, 
                        error: `账号数量已达上限（${accountLimit}个），请购买额度卡密增加额度` 
                    });
                }
            }

            const resolvedUpdateId = isUpdate ? resolveAccId(body.id) : '';
            const payload = isUpdate
                ? { ...body, id: resolvedUpdateId || String(body.id) }
                : { ...body };
            const wxSessionId = String(body.wxSessionId || '');
            delete payload.wxSessionId;
            delete payload.loginBuffer;
            delete payload.refreshtoken;
            delete payload.accesstoken;
            let pendingWxSessionId = '';
            let wasRunning = false;
            if (isUpdate && provider.isAccountRunning) {
                wasRunning = provider.isAccountRunning(payload.id);
            }

            // 检查是否仅修改了备注信息
            let onlyRemarkChanged = false;
            if (isUpdate) {
                const oldAccounts = provider.getAccounts();
                const oldAccount = oldAccounts.accounts.find((a: DynamicRecord) => a.id === payload.id);
                if (oldAccount) {
                    // 检查 payload 中是否只包含 id 和 name 字段
                    const payloadKeys = Object.keys(payload);
                    const onlyIdAndName = payloadKeys.length === 2 && payloadKeys.includes('id') && payloadKeys.includes('name');
                    if (onlyIdAndName) {
                        onlyRemarkChanged = true;
                    }
                }
            }

            // 如果是新增账号，自动关联当前用户
            if (!isUpdate && currentUser) {
                payload.username = currentUser.username;
            }

            // 微信账号：loginBuffer/refreshtoken 只允许来自扫码会话——创建/更新都禁止 body 直接传（防凭证覆盖 DoS），
            // 创建/编辑时仅从当前用户明确提交的扫码会话补充，账号持久化成功后再消费会话。
            if (body.platform === 'wx' && body.wxid) {
                let wxidChanged = false;
                if (isUpdate) {
                    // 微信账号变更 wxid（换绑）时清除旧凭证，避免新 wxid 继承上一用户的 loginBuffer/refreshtoken
                    const oldAccounts = provider.getAccounts();
                    const oldWxAccount = (oldAccounts.accounts || []).find((a: DynamicRecord) => a.id === payload.id);
                    if (oldWxAccount && oldWxAccount.wxid && String(oldWxAccount.wxid) !== String(body.wxid)) {
                        wxidChanged = true;
                        payload.loginBuffer = '';
                        payload.refreshtoken = '';
                        payload.accesstoken = '';
                    }
                }
                const requiresWxSession = !isUpdate || wxidChanged || body.loginType === 'wx_qr' || wxSessionId;
                if (requiresWxSession) {
                    const pending = wxLoginAdapter.peekPendingWxInfo(
                        wxSessionId,
                        String(body.wxid),
                        currentUser.username,
                    );
                    if (!pending) {
                        return res.status(400).json({ ok: false, error: '扫码会话无效或已过期，请重新扫码' });
                    }
                    pendingWxSessionId = pending.sessionId;
                    if (pending.loginBuffer) payload.loginBuffer = pending.loginBuffer;
                    if (pending.refreshtoken) payload.refreshtoken = pending.refreshtoken;
                    if (pending.accesstoken) payload.accesstoken = pending.accesstoken;
                    if (!payload.avatar && pending.avatar) payload.avatar = pending.avatar;
                }
            }

            const saveAccount = () => {
                const saved = addOrUpdateAccount(payload);
                if (pendingWxSessionId) {
                    wxLoginAdapter.consumePendingWxInfo(
                        pendingWxSessionId,
                        String(body.wxid),
                        currentUser.username,
                    );
                }
                return saved;
            };
            // 运行中账号重扫时与主进程的保活/code 刷新共用同一把锁，防止旧请求晚到覆盖新凭证。
            const data = pendingWxSessionId && payload.id
                ? await wxLoginAdapter.withAccountCredentialLock(body.wxid, payload.id, saveAccount)
                : saveAccount();
            if (provider.addAccountLog) {
                const accountId = isUpdate ? String(payload.id) : String((data.accounts[data.accounts.length - 1] || {}).id || '');
                const accountName = payload.name || '';
                provider.addAccountLog(
                    isUpdate ? 'update' : 'add',
                    isUpdate ? `更新账号: ${accountName || accountId}` : `添加账号: ${accountName || accountId}`,
                    accountId,
                    accountName
                );
            }
            // 如果是新增，自动启动
            if (!isUpdate) {
                const newAcc = data.accounts[data.accounts.length - 1];
                if (newAcc) provider.startAccount(newAcc.id);
            } else if (wasRunning && !onlyRemarkChanged) {
                // 如果是更新，且之前在运行，且不是仅修改备注，则重启
                provider.restartAccount(payload.id);
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    app.delete('/api/accounts/:id', (req, res) => {
        try {
            const resolvedId = resolveAccId(req.params.id) || String(req.params.id || '');

            // 检查权限
            if (!checkAccountAccess(req, resolvedId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const before = provider.getAccounts();
            const target = findAccountByRef(before.accounts || [], req.params.id);
            provider.stopAccount(resolvedId);
            const data = deleteAccount(resolvedId);
            if (provider.addAccountLog) {
                provider.addAccountLog('delete', `删除账号: ${(target && target.name) || req.params.id}`, resolvedId, target ? target.name : '');
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

    // API: 账号日志
    app.get('/api/account-logs', (req, res) => {
        try {
            const limit = Number.parseInt(req.query.limit) || 100;
            const currentUser = req.currentUser;

            let list = provider.getAccountLogs ? provider.getAccountLogs(limit) : [];
            if (!Array.isArray(list)) list = [];

            // 所有用户（包括管理员）只能看到自己账号的操作日志
            if (currentUser) {
                const accessibleIds = getAccessibleAccountIds(req);
                list = list.filter((log: DynamicRecord) => {
                    const logAccountId = log.accountId || log.id;
                    return accessibleIds.includes(logAccountId);
                });
            }

            // 与当前 web 前端保持一致：直接返回数组
            res.json(list);
        } catch (e) {
            res.status(500).json({ ok: false, error: errorMessage(e) });
        }
    });

}

export { registerAccountRoutes };
