const { Buffer } = require('node:buffer');
const EventEmitter = require('node:events');
/**
 * WebSocket 网络层 - 连接/消息编解码/登录/心跳
 */

const process = require('node:process');
const WebSocket = require('ws');
const { CONFIG, getClientVersion, setClientVersionPrefix, getVersionPrefix } = require('../config/config');
const { createScheduler } = require('../services/scheduler');
const { updateStatusFromLogin, updateStatusGold, updateStatusLevel } = require('../services/status');
const { recordOperation } = require('../services/stats');
const { types } = require('./proto');
const { toLong, toNum, syncServerTime, log, logWarn } = require('./utils');
const cryptoWasm = require('./crypto-wasm');
const { encodeGatewayRequest } = require('./gateway-request');
const { canReserveRequest } = require('./request-coordination');
const { startAceRuntime } = require('../services/ace');

// ============ 事件发射器 (用于推送通知) ============
const networkEvents = new EventEmitter();

// ============ 内部状态 ============
let ws = null;
let clientSeq = 1;
let serverSeq = 0;
const pendingCallbacks = new Map();
let wsErrorState = { code: 0, at: 0, message: '' };
const networkScheduler = createScheduler('network');
const MAX_PENDING_REQUESTS = 5;
const MAX_BUSINESS_REQUESTS = 4;
let connectionRevision = 0;
let lastInboundAt = Date.now();

function rejectAllPendingRequests(reason = '请求被中断') {
    const entries = Array.from(pendingCallbacks.entries());
    pendingCallbacks.clear();
    for (const [seq, entry] of entries) {
        networkScheduler.clear(`request_timeout_${seq}`);
        try {
            entry.callback(new Error(reason));
        } catch {
            // ignore callback failure
        }
    }
    return entries.length;
}

// ============ 用户状态 (登录后设置) ============
const userState = {
    gid: 0,
    name: '',
    level: 0,
    gold: 0,
    exp: 0,
    openid: '',
    coupon: 0, // 点券(ID:1002)
    goldBean: 0, // 金豆豆(ID:1005)
};

function getUserState() { return userState; }
function getWsErrorState() { return { ...wsErrorState }; }
function setWsErrorState(code, message) {
    wsErrorState = { code: Number(code) || 0, at: Date.now(), message: message || '' };
}
function clearWsErrorState() {
    wsErrorState = { code: 0, at: 0, message: '' };
}

function hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// ============ 消息编解码 ============
// async function encodeMsg(serviceName, methodName, bodyBytes) {
async function encodeMsg(serviceName, methodName, bodyBytes, clientSeqValue) {
    let finalBody = bodyBytes || Buffer.alloc(0);
    if (finalBody.length > 0) {
        finalBody = await cryptoWasm.encryptBuffer(finalBody);
    }
    return encodeGatewayRequest(serviceName, methodName, finalBody, clientSeqValue, serverSeq);
}

async function sendMsg(serviceName, methodName, bodyBytes, callback) {
    const socket = ws;
    const revision = connectionRevision;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        log('系统', '[WS] 连接未打开');
        return false;
    }
    const seq = clientSeq;
    clientSeq += 1;
    let completed = false;
    const finish = (error, body, meta) => {
        if (completed) return;
        completed = true;
        pendingCallbacks.delete(seq);
        if (callback) callback(error, body, meta);
    };
    if (callback) {
        pendingCallbacks.set(seq, {
            callback: finish,
            serviceName,
            methodName,
            category: 'control',
            startedAt: Date.now(),
            sentAt: 0,
            revision,
        });
    }
    try {
        const encoded = await encodeMsg(serviceName, methodName, bodyBytes, seq);
        if (revision !== connectionRevision || socket !== ws || socket.readyState !== WebSocket.OPEN) {
            throw new Error(`请求已中断: ${methodName}`);
        }
        const entry = pendingCallbacks.get(seq);
        if (entry) entry.sentAt = Date.now();
        await new Promise((resolve, reject) => {
            socket.send(encoded, error => error ? reject(error) : resolve());
        });
    } catch (err) {
        if (callback) {
            finish(err);
        }
        return false;
    }
    return true;
}

/** 网关错误（含服务端错误码） */
class GatewayError extends Error {
    constructor(meta) {
        const code = toNum(meta && meta.error_code);
        const serviceName = String((meta && meta.service_name) || '');
        const methodName = String((meta && meta.method_name) || '');
        const errorMessage = String((meta && meta.error_message) || '');
        super(`${serviceName}.${methodName} 错误: code=${code} ${errorMessage}`.trim());
        this.name = 'GatewayError';
        this.code = code;
        this.serviceName = serviceName;
        this.methodName = methodName;
        this.errorMessage = errorMessage;
        this.clientSeq = toNum(meta && meta.client_seq);
    }
}

/** Promise 版发送（timeoutOrOptions 支持数字超时或 { timeoutMs, expectedErrorCodes } 选项对象） */
function sendMsgAsync(serviceName, methodName, bodyBytes, timeoutOrOptions = 20000) {
    const options = typeof timeoutOrOptions === 'number'
        ? { timeoutMs: timeoutOrOptions }
        : (timeoutOrOptions || {});
    const timeout = Math.max(1, Number(options.timeoutMs) || 20000);
    const category = options.category === 'control' ? 'control' : 'business';
    return new Promise((resolve, reject) => {
        // 检查连接状态
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error(`连接未打开: ${methodName}`));
            return;
        }

        if (!canReserveRequest(pendingCallbacks.values(), category, {
            maxPending: MAX_PENDING_REQUESTS,
            maxBusiness: MAX_BUSINESS_REQUESTS,
        })) {
            reject(new Error(`请求队列已满: ${methodName} (pending=${pendingCallbacks.size})`));
            return;
        }

        const socket = ws;
        const revision = connectionRevision;
        const seq = clientSeq++;
        const timeoutKey = `request_timeout_${seq}`;
        let completed = false;
        const startedAt = Date.now();
        const finish = (error, body, meta) => {
            if (completed) return;
            completed = true;
            pendingCallbacks.delete(seq);
            networkScheduler.clear(timeoutKey);
            if (error) reject(error);
            else resolve({ body, meta });
        };
        const entry = {
            callback: finish,
            serviceName,
            methodName,
            category,
            startedAt,
            sentAt: 0,
            revision,
        };
        pendingCallbacks.set(seq, entry);
        networkScheduler.setTimeoutTask(timeoutKey, timeout, () => {
            const error = new Error(`请求超时: ${methodName} (seq=${seq}, pending=${Math.max(0, pendingCallbacks.size - 1)}, elapsed=${Date.now() - startedAt}ms)`);
            error.code = 'REQUEST_TIMEOUT';
            error.sentAt = entry.sentAt;
            finish(error);
        });

        Promise.resolve().then(async () => {
            const encoded = await encodeMsg(serviceName, methodName, bodyBytes, seq);
            if (completed) return;
            if (revision !== connectionRevision || socket !== ws || socket.readyState !== WebSocket.OPEN) {
                throw new Error(`请求已中断: ${methodName}`);
            }
            entry.sentAt = Date.now();
            socket.send(encoded, (error) => {
                if (error) finish(error);
            });
        }).catch(error => finish(error));
    });
}

// ============ 消息处理 ============
function handleMessage(data) {
    try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const msg = types.GateMessage.decode(buf);
        const meta = msg.meta;
        if (!meta) return;
        lastInboundAt = Date.now();

        if (meta.server_seq) {
            const seq = toNum(meta.server_seq);
            if (seq > serverSeq) serverSeq = seq;
        }

        const msgType = meta.message_type;

        // Notify
        if (msgType === 3) {
            handleNotify(msg);
            return;
        }

        // Response
        if (msgType === 2) {
            const errorCode = toNum(meta.error_code);
            const clientSeqVal = toNum(meta.client_seq);

            const entry = pendingCallbacks.get(clientSeqVal);
            if (entry) {
                pendingCallbacks.delete(clientSeqVal);
                if (errorCode !== 0) {
                    entry.callback(new GatewayError(meta));
                } else {
                    entry.callback(null, msg.body, meta);
                }
                return;
            }

            if (errorCode !== 0) {
                logWarn('错误', `${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`);
            }
        }
    } catch (err) {
        logWarn('解码', err.message);
    }
}

// 服务端版本信息校准：登录回复/心跳回复里的 version_info 带推荐/强制版本，
// 提取版本前缀并与本地比较，不同则自动更新（根治"客户端版本过低"被踢）。
function applyServerVersionInfo(versionInfo) {
    try {
        if (!versionInfo || typeof versionInfo !== 'object') return;
        const ver = String(versionInfo.version_force || versionInfo.version_recommend || '').trim();
        if (!ver) return;
        const prefix = ver.split('_')[0].trim();
        if (!prefix || prefix === getVersionPrefix()) return;
        setClientVersionPrefix(prefix);
        log('系统', `服务端版本信息: ${ver}，已自动校准客户端版本前缀为 ${prefix}`);
        networkEvents.emit('versionPrefixChanged', prefix);
    } catch { }
}

function handleNotify(msg) {
    if (!msg.body || msg.body.length === 0) return;
    try {
        const event = types.EventMessage.decode(msg.body);
        const type = event.message_type || '';
        const eventBody = event.body;

        // 被踢下线
        if (type.includes('Kickout')) {
            log('推送', `被踢下线! ${type}`);
            try {
                const notify = types.KickoutNotify.decode(eventBody);
                log('推送', `原因: ${notify.reason_message || '未知'}`);
                networkEvents.emit('kickout', {
                    type,
                    reason: notify.reason_message || '未知',
                });
            } catch { }
            return;
        }

        // 土地状态变化 (被放虫/放草/偷菜等)
        if (type.includes('LandsNotify')) {
            try {
                const notify = types.LandsNotify.decode(eventBody);
                const hostGid = toNum(notify.host_gid);
                const lands = notify.lands || [];
                if (lands.length > 0) {
                    // 如果是自己的农场，触发事件
                    if (hostGid === userState.gid || hostGid === 0) {
                        networkEvents.emit('landsChanged', lands);
                    }
                }
            } catch { }
            return;
        }

        // 物品变化通知 (经验/金币等)
        if (type.includes('ItemNotify')) {
            try {
                const notify = types.ItemNotify.decode(eventBody);
                const items = notify.items || [];
                for (const itemChg of items) {
                    const item = itemChg.item;
                    if (!item) continue;
                    const id = toNum(item.id);
                    const count = toNum(item.count);
                    const delta = toNum(itemChg.delta);
                    
                    // 仅使用 ID=1101 作为经验值标准
                    if (id === 1101) {
                        // 优先使用总量；若仅有 delta 也可累加
                        if (count > 0) userState.exp = count;
                        else if (delta !== 0) userState.exp = Math.max(0, Number(userState.exp || 0) + delta);
                        // 这里调用 updateStatusLevel 会触发 status.js -> worker.js -> stats.js 的更新流程
                        updateStatusLevel(userState.level, userState.exp);
                    } else if (id === 1 || id === 1001) {
                        // 金币通知有时只有 delta 没有总量，避免把未提供总量误当 0 覆盖
                        if (count > 0) {
                            userState.gold = count;
                        } else if (delta !== 0) {
                            userState.gold = Math.max(0, Number(userState.gold || 0) + delta);
                        }
                        updateStatusGold(userState.gold);
                    } else if (id === 1002) {
                        // 点券
                        if (count > 0) {
                            userState.coupon = count;
                        } else if (delta !== 0) {
                            userState.coupon = Math.max(0, Number(userState.coupon || 0) + delta);
                        }
                    } else if (id === 1005) {
                        // 金豆豆
                        if (count > 0) {
                            userState.goldBean = count;
                        } else if (delta !== 0) {
                            userState.goldBean = Math.max(0, Number(userState.goldBean || 0) + delta);
                        }
                    }
                }
            } catch { }
            return;
        }

        // 基本信息变化 (升级等)
        if (type.includes('BasicNotify')) {
            try {
                const notify = types.BasicNotify.decode(eventBody);
                if (notify.basic) {
                    const oldLevel = userState.level;
                    if (hasOwn(notify.basic, 'level')) {
                        const nextLevel = toNum(notify.basic.level);
                        if (Number.isFinite(nextLevel) && nextLevel > 0) userState.level = nextLevel;
                    }
                    let shouldUpdateGoldView = false;
                    if (hasOwn(notify.basic, 'gold')) {
                        const nextGold = toNum(notify.basic.gold);
                        if (Number.isFinite(nextGold) && nextGold >= 0) {
                            userState.gold = nextGold;
                            shouldUpdateGoldView = true;
                        }
                    }
                    if (hasOwn(notify.basic, 'exp')) {
                        const exp = toNum(notify.basic.exp);
                        if (Number.isFinite(exp) && exp >= 0) {
                            userState.exp = exp;
                            updateStatusLevel(userState.level, exp);
                        }
                    }
                    if (shouldUpdateGoldView) {
                        updateStatusGold(userState.gold);
                    }
                    if (userState.level !== oldLevel) {
                        recordOperation('levelUp', 1);
                    }
                }
            } catch { }
            return;
        }

        // 好友申请通知 (微信同玩)
        if (type.includes('FriendApplicationReceivedNotify')) {
            try {
                const notify = types.FriendApplicationReceivedNotify.decode(eventBody);
                const applications = notify.applications || [];
                if (applications.length > 0) {
                    networkEvents.emit('friendApplicationReceived', applications);
                }
            } catch { }
            return;
        }

        // 好友添加成功通知
        if (type.includes('FriendAddedNotify')) {
            try {
                const notify = types.FriendAddedNotify.decode(eventBody);
                const friends = notify.friends || [];
                if (friends.length > 0) {
                    const names = friends.map(f => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
                    log('好友', `新好友: ${names}`);
                }
            } catch { }
            return;
        }

        // 商品解锁通知 (升级后解锁新种子等)
        if (type.includes('GoodsUnlockNotify')) {
            try {
                const notify = types.GoodsUnlockNotify.decode(eventBody);
                const goods = notify.goods_list || [];
                if (goods.length > 0) {
                    networkEvents.emit('goodsUnlockNotify', goods);
                }
            } catch { }
            return;
        }

        // 任务状态变化通知
        if (type.includes('TaskInfoNotify')) {
            try {
                const notify = types.TaskInfoNotify.decode(eventBody);
                if (notify.task_info) {
                    networkEvents.emit('taskInfoNotify', notify.task_info);
                }
            } catch { }
            return;
        }

        // 战令（千星游记）进度变化通知：推送驱动自动领取
        if (type.includes('BattlePassChangeNotify')) {
            try {
                const notify = types.BattlePassChangeNotify.decode(eventBody);
                networkEvents.emit('battlePassNotify', notify.pass);
            } catch { }
            return;
        }

        // 红点类通知（图鉴/头像框/成就等）：界面状态提示，bot 无需响应，静默识别避免刷"未处理"日志
        if (type.includes('RedDotNotify')) {
            return;
        }

        // 商城需求通知：空信号（无数据），触发主动探测商城各 slot 定位神秘商人/活动商店
        if (type.includes('NeedNotify')) {
            networkEvents.emit('mallNeedNotify');
            return;
        }

        // 互动（访客）新记录通知：访客功能已有每日同步，无需即时响应
        if (type.includes('InteractNewRecordNotify')) {
            return;
        }

        // 其他未处理的推送类型（新协议信号，开发调试用，默认被日志页过滤）
        const gid = toNum((getUserState() || {}).gid) || '';
        log('推送', `未处理类型: ${type}`, { module: 'push', event: 'unhandled_push', type, gid, dev: true });
    } catch (e) {
        logWarn('推送', `解码失败: ${e.message}`);
    }
}

// ============ 登录 ============
async function sendLogin(onLoginSuccess) {
    const body = types.LoginRequest.encode(types.LoginRequest.create({
        sharer_id: toLong(0),
        sharer_open_id: '',
        device_info: {
            client_version: getClientVersion(),
            sys_software: 'iOS 26.2.1',
            network: 'wifi',
            memory: '7672',
            device_id: 'iPhone X<iPhone18,3>',
        },
        share_cfg_id: toLong(0),
        scene_id: '1256',
        report_data: {
            callback: '', cd_extend_info: '', click_id: '', clue_token: '',
            minigame_channel: 'other', minigame_platid: 2, req_id: '', trackid: '',
        },
    })).finish();

    await sendMsg('gamepb.userpb.UserService', 'Login', body, (err, bodyBytes, _meta) => {
        if (err) {
            log('登录', `失败: ${err.message}`);
            // 如果是验证失败，直接退出进程
            if (err.message.includes('code=')) {
                log('系统', '账号验证失败，即将停止运行...');
                networkScheduler.setTimeoutTask('login_error_exit', 1000, () => process.exit(0));
            }
            return;
        }
        try {
            const reply = types.LoginReply.decode(bodyBytes);
            applyServerVersionInfo(reply.version_info);
            if (reply.basic) {
                clearWsErrorState();
                userState.gid = toNum(reply.basic.gid);
                userState.name = reply.basic.name || '未知';
                userState.level = toNum(reply.basic.level);
                userState.gold = toNum(reply.basic.gold);
                userState.exp = toNum(reply.basic.exp);

                // 更新状态栏
                updateStatusFromLogin({
                    name: userState.name,
                    level: userState.level,
                    gold: userState.gold,
                    exp: userState.exp,
                });

                log('系统', `登录成功: ${userState.name} (Lv${userState.level})`);

                console.warn('');
                console.warn('========== 登录成功 ==========');
                console.warn(`  GID:    ${userState.gid}`);
                console.warn(`  昵称:   ${userState.name}`);
                console.warn(`  等级:   ${userState.level}`);
                console.warn(`  金币:   ${userState.gold}`);
                if (reply.time_now_millis) {
                    syncServerTime(toNum(reply.time_now_millis));
                    console.warn(`  时间:   ${new Date(toNum(reply.time_now_millis)).toLocaleString()}`);
                }
                console.warn('===============================');
                console.warn('');

                // ACE 反作弊：绑定用户并启动定时 AntiData 上报（模拟真实客户端，避免服务端挂起）
                userState.openid = String(reply.basic && reply.basic.open_id || '').trim();
                if (userState.openid) {
                    cryptoWasm.bindUser(userState.openid).catch(() => {});
                }
                startAceRuntime(sendMsgAsync);

            }

            startHeartbeat();
            if (onLoginSuccess) onLoginSuccess();
        } catch (e) {
            log('登录', `解码失败: ${e.message}`);
        }
    });
}

// ============ 心跳 ============
let heartbeatInFlight = false;
const HEARTBEAT_TIMEOUT = 20000;

function startHeartbeat() {
    networkScheduler.clear('heartbeat_interval');
    lastInboundAt = Date.now();
    heartbeatInFlight = false;

    networkScheduler.setIntervalTask('heartbeat_interval', CONFIG.heartbeatInterval, () => {
        if (!userState.gid) return;

        if (heartbeatInFlight) return;

        const body = types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
            gid: toLong(userState.gid),
            client_version: getClientVersion(),
        })).finish();
        heartbeatInFlight = true;
        sendMsgAsync('gamepb.userpb.UserService', 'Heartbeat', body, {
            timeoutMs: HEARTBEAT_TIMEOUT,
            category: 'control',
        }).then(({ body: replyBody }) => {
            try {
                const reply = types.HeartbeatReply.decode(replyBody);
                applyServerVersionInfo(reply.version_info);
                if (reply.server_time) syncServerTime(toNum(reply.server_time));
            } catch { }
        }).catch((error) => {
            const wasSent = Number(error && error.sentAt) > 0;
            const noInboundSinceSend = lastInboundAt <= Number(error && error.sentAt);
            if (error && error.code === 'REQUEST_TIMEOUT' && wasSent && noInboundSinceSend) {
                logWarn('心跳', `心跳请求超时且 ${Math.round((Date.now() - lastInboundAt) / 1000)}s 无入站消息，立即重连`);
                reconnect(null);
            }
        }).finally(() => {
            heartbeatInFlight = false;
        });
    });
}

// ============ WebSocket 连接 ============
let savedLoginCallback = null;
let savedCode = null;

function connect(code, onLoginSuccess) {
    connectionRevision += 1;
    const revision = connectionRevision;
    savedLoginCallback = onLoginSuccess;
    if (code) savedCode = code;
    const url = `${CONFIG.serverUrl}?platform=${CONFIG.platform}&os=${CONFIG.os}&ver=${getClientVersion()}&code=${savedCode}&openID=`;

    const socket = new WebSocket(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
            'Origin': 'https://gate-obt.nqf.qq.com',
        },
    });

    ws = socket;
    socket.binaryType = 'arraybuffer';

    socket.on('open', () => {
        if (revision !== connectionRevision || socket !== ws) return;
        sendLogin(onLoginSuccess);
    });

    socket.on('message', (data) => {
        if (revision !== connectionRevision || socket !== ws) return;
        handleMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    socket.on('close', (code, _reason) => {
        if (revision !== connectionRevision || socket !== ws) return;
        console.warn(`[WS] 连接关闭 (code=${code})`);
        cleanup();
        // 连接被拒（400，code 过期）：跳过自动重连，等 worker 刷新 code 后手动重连
        if (skipAutoReconnect) {
            skipAutoReconnect = false;
            return;
        }
        // 自动重连：延迟 2s 后重试，复用已保存的登录回调
        if (savedLoginCallback) {
            networkScheduler.setTimeoutTask('auto_reconnect', 2000, () => {
                log('系统', '[WS] 尝试自动重连...');
                reconnect(null);
            });
        }
    });

    socket.on('error', (err) => {
        if (revision !== connectionRevision || socket !== ws) return;
        const message = err && err.message ? String(err.message) : '';
        logWarn('系统', `[WS] 错误: ${message}`);
        const match = message.match(/Unexpected server response:\s*(\d+)/i);
        if (match) {
            const code = Number.parseInt(match[1], 10) || 0;
            if (code) {
                setWsErrorState(code, message);
                networkEvents.emit('ws_error', { code, message });
                // 400 = 登录 code 过期：通知 worker 刷新 code，跳过自动重连（旧 code 重连会死循环）
                if (code === 400) {
                    skipAutoReconnect = true;
                    networkEvents.emit('ws_code_rejected');
                }
            }
        }
    });
}

// 连接被拒（code 过期）时跳过自动重连，等待 worker 刷新 code 后手动重连
let skipAutoReconnect = false;

function cleanup(reason = '网络清理') {
    connectionRevision += 1;
    heartbeatInFlight = false;
    rejectAllPendingRequests(`请求已中断: ${reason}`);
    networkScheduler.clearAll();
    // pendingCallbacks.clear();
}

function reconnect(newCode) {
    cleanup('主动重连');
    if (ws) {
        ws.removeAllListeners();
        ws.close();
        ws = null;
    }
    userState.gid = 0;
    connect(newCode || savedCode, savedLoginCallback);
}

function getWs() { return ws; }

module.exports = {
    connect, reconnect, cleanup, getWs,
    sendMsg, sendMsgAsync,
    getUserState,
    getWsErrorState,
    GatewayError,
    networkEvents,
};
