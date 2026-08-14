import { sendMsgAsync } from '../utils/network';
import { types } from '../utils/proto';
import { toNum } from '../utils/utils';

const DEFAULT_RECHARGE_SOURCE = 'MallUI';

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

// 查询充值信息（钻石余额来源）
async function getRechargeInfo(source: unknown = DEFAULT_RECHARGE_SOURCE) {
    const body = types.GetRechargeInfoRequest.encode(
        types.GetRechargeInfoRequest.create({
            source: String(source || DEFAULT_RECHARGE_SOURCE),
        }),
    ).finish();
    const { body: replyBody } = await sendMsgAsync(
        'gamepb.paypb.PayService',
        'GetRechargeInfo',
        body,
    );
    return types.GetRechargeInfoReply.decode(replyBody);
}

// 钻石余额
async function getDiamondBalance(): Promise<number> {
    const reply = await getRechargeInfo();
    const rechargeInfos = asRecord(reply).recharge_infos;
    const infos = Array.isArray(rechargeInfos) ? rechargeInfos : [];
    return Math.max(0, toNum(asRecord(infos[0]).balance));
}

export {
    DEFAULT_RECHARGE_SOURCE,
    getDiamondBalance,
    getRechargeInfo,
};
