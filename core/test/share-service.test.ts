const assert = require('node:assert/strict');
const test = require('node:test');
const { loadProto, types } = require('../src/utils/proto');

test.before(async () => loadProto());

test('分享任务已完成但礼包未领取时直接补领', async (t) => {
    const networkPath = require.resolve('../src/utils/network');
    const sharePath = require.resolve('../src/services/share');
    const network = require(networkPath);
    const originalSendMsgAsync = network.sendMsgAsync;
    const methods: string[] = [];

    network.sendMsgAsync = async (_service: string, method: string) => {
        methods.push(method);
        if (method === 'CheckCanShare') {
            return {
                body: types.CheckCanShareReply.encode(
                    types.CheckCanShareReply.create({ can_share: false }),
                ).finish(),
            };
        }
        if (method === 'ClaimShareReward') {
            return {
                body: types.ClaimShareRewardReply.encode(
                    types.ClaimShareRewardReply.create({
                        items: [{ id: 1026, count: 2 }],
                    }),
                ).finish(),
            };
        }
        throw new Error(`不应调用 ${method}`);
    };
    delete require.cache[sharePath];
    t.after(() => {
        network.sendMsgAsync = originalSendMsgAsync;
        delete require.cache[sharePath];
    });

    const { performDailyShare } = require(sharePath);
    assert.equal(await performDailyShare(true), true);
    assert.deepEqual(methods, ['CheckCanShare', 'ClaimShareReward']);
});

test('分享礼包补领遇到瞬时失败时保留当天重试机会', async (t) => {
    const networkPath = require.resolve('../src/utils/network');
    const sharePath = require.resolve('../src/services/share');
    const network = require(networkPath);
    const originalSendMsgAsync = network.sendMsgAsync;
    let claimAttempts = 0;

    network.sendMsgAsync = async (_service: string, method: string) => {
        if (method === 'CheckCanShare') {
            return {
                body: types.CheckCanShareReply.encode(
                    types.CheckCanShareReply.create({ can_share: false }),
                ).finish(),
            };
        }
        if (method === 'ClaimShareReward') {
            claimAttempts += 1;
            if (claimAttempts === 1) throw new Error('network timeout');
            return {
                body: types.ClaimShareRewardReply.encode(
                    types.ClaimShareRewardReply.create({ items: [{ id: 1026, count: 2 }] }),
                ).finish(),
            };
        }
        throw new Error(`不应调用 ${method}`);
    };
    delete require.cache[sharePath];
    t.after(() => {
        network.sendMsgAsync = originalSendMsgAsync;
        delete require.cache[sharePath];
    });

    const { getShareDailyState, performDailyShare } = require(sharePath);
    assert.equal(await performDailyShare(true), false);
    assert.equal(getShareDailyState().doneToday, false);
    assert.equal(await performDailyShare(true), true);
    assert.equal(getShareDailyState().doneToday, true);
    assert.equal(claimAttempts, 2);
});

export {};
