import { getFruitName, getPlantByFruitId, getPlantById, getPlantName } from '../config/gameConfig';
import { sendMsgAsync } from '../utils/network';
import { types } from '../utils/proto';
import { logWarn, toNum, toTimeSec } from '../utils/utils';
import { asRecord, errorMessage, recordArray } from './service-boundaries';

const RPC_CANDIDATES: ReadonlyArray<readonly [string, string]> = [
    ['gamepb.interactpb.InteractService', 'InteractRecords'],
    ['gamepb.interactpb.InteractService', 'GetInteractRecords'],
    ['gamepb.interactpb.VisitorService', 'InteractRecords'],
    ['gamepb.interactpb.VisitorService', 'GetInteractRecords'],
];

const ACTION_LABELS: Record<number, string> = {
    1: '偷取作物',
    2: '帮忙',
    3: '捣乱',
};

export interface InteractRecord {
    key: string;
    serverTimeSec: number;
    serverTimeMs: number;
    actionType: number;
    actionLabel: string;
    actionDetail: string;
    visitorGid: number;
    nick: string;
    avatarUrl: string;
    cropId: number;
    cropName: string;
    cropCount: number;
    times: number;
    fromType: number;
    level: number;
    landId: number;
    flag1: number;
    flag2: number;
}

function getActionLabel(actionType: number): string {
    return ACTION_LABELS[actionType] || '互动';
}

function buildActionDetail(record: Omit<InteractRecord, 'actionDetail'>): string {
    const count = Number(record.cropCount) || 0;
    const times = Number(record.times) || 0;
    const landId = Number(record.landId) || 0;
    const parts: string[] = [];

    if (record.actionType === 1) {
        if (record.cropName && count > 0) parts.push(`偷取 ${record.cropName} × ${count}`);
        else if (record.cropName) parts.push(`偷取 ${record.cropName}`);
        else if (count > 0) parts.push(`偷取作物 × ${count}`);
        else parts.push('偷取作物');
    } else if (record.actionType === 2) {
        parts.push(times > 1 ? `帮忙 ${times} 次` : '帮忙');
    } else if (record.actionType === 3) {
        parts.push(times > 1 ? `捣乱 ${times} 次` : '捣乱');
    } else {
        parts.push(times > 1 ? `互动 ${times} 次` : '互动');
    }

    if (landId > 0) parts.push(`地块 ${landId}`);
    return parts.join(' · ');
}

async function fetchInteractReply() {
    if (!types.InteractRecordsRequest || !types.InteractRecordsReply) {
        throw new Error('访客记录 proto 未加载');
    }

    const body = types.InteractRecordsRequest.encode(types.InteractRecordsRequest.create({})).finish();
    const errors: string[] = [];

    for (const [serviceName, methodName] of RPC_CANDIDATES) {
        try {
            const { body: replyBody } = await sendMsgAsync(serviceName, methodName, body, 2500);
            return types.InteractRecordsReply.decode(replyBody);
        } catch (error) {
            const message = errorMessage(error);
            errors.push(`${serviceName}.${methodName}: ${message}`);
        }
    }

    logWarn('好友', `访客记录接口调用失败: ${errors.join(' | ')}`, {
        module: 'friend',
        event: 'interact_records',
        result: 'error',
    });
    throw new Error('访客记录接口调用失败，请确认服务名和方法名是否与当前版本一致');
}

function resolveCropName(cropId: unknown): string {
    const id = Number(cropId) || 0;
    if (id <= 0) return '';
    if (getPlantById(id)) return getPlantName(id);
    if (getPlantByFruitId(id)) return getFruitName(id);
    return '';
}

function normalizeInteractRecord(record: unknown, index: number): InteractRecord {
    const source = asRecord(record);
    const actionType = toNum(source.action_type);
    const visitorGid = toNum(source.visitor_gid);
    const cropId = toNum(source.crop_id);
    const cropCount = toNum(source.crop_count);
    const times = toNum(source.times);
    const level = toNum(source.level);
    const fromType = toNum(source.from_type);
    const serverTimeSec = toTimeSec(source.server_time);
    const extra = asRecord(source.extra);
    const landId = toNum(extra.land_id);
    const flag1 = toNum(extra.flag1);
    const flag2 = toNum(extra.flag2);
    const cropName = resolveCropName(cropId);
    const nick = String(source.nick || '').trim() || `GID:${visitorGid}`;
    const avatarUrl = String(source.avatar_url || '').trim();

    const normalized: Omit<InteractRecord, 'actionDetail'> = {
        key: `${serverTimeSec || 0}-${visitorGid || 0}-${actionType || 0}-${index}`,
        serverTimeSec,
        serverTimeMs: serverTimeSec > 0 ? serverTimeSec * 1000 : 0,
        actionType,
        actionLabel: getActionLabel(actionType),
        visitorGid,
        nick,
        avatarUrl,
        cropId,
        cropName,
        cropCount,
        times,
        fromType,
        level,
        landId,
        flag1,
        flag2,
    };

    return { ...normalized, actionDetail: buildActionDetail(normalized) };
}

async function getInteractRecords(): Promise<InteractRecord[]> {
    const reply = await fetchInteractReply();
    const records = recordArray(asRecord(reply).records);
    return records
        .map((record, index) => normalizeInteractRecord(record, index))
        .sort((a, b) => (b.serverTimeSec - a.serverTimeSec) || (b.visitorGid - a.visitorGid) || (b.actionType - a.actionType));
}

export {
    getInteractRecords,
};
