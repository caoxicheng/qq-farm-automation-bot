import protobuf from 'protobufjs';

export interface ProtobufAuditIssue {
    path: string;
    fieldNumber: number;
    message: string;
}

const VARINT_TYPES = new Set([
    'int32', 'uint32', 'sint32', 'int64', 'uint64', 'sint64', 'bool',
]);
const FIXED64_TYPES = new Set(['fixed64', 'sfixed64', 'double']);
const FIXED32_TYPES = new Set(['fixed32', 'sfixed32', 'float']);

function expectedWireType(field: protobuf.Field): number {
    if (field.resolvedType instanceof protobuf.Enum || VARINT_TYPES.has(field.type)) return 0;
    if (FIXED64_TYPES.has(field.type)) return 1;
    if (FIXED32_TYPES.has(field.type)) return 5;
    return 2;
}

function isPackable(field: protobuf.Field): boolean {
    return field.repeated && expectedWireType(field) !== 2;
}

function skipField(reader: protobuf.Reader, wireType: number): void {
    reader.skipType(wireType);
}

function auditType(
    type: protobuf.Type,
    buffer: Uint8Array,
    path: string,
    issues: ProtobufAuditIssue[],
): void {
    const reader = protobuf.Reader.create(buffer);
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const fieldNumber = tag >>> 3;
        const wireType = tag & 7;
        const field = type.fieldsById[fieldNumber];
        if (!field) {
            issues.push({ path, fieldNumber, message: `字段 #${fieldNumber} 未在 ${type.fullName} 中定义` });
            skipField(reader, wireType);
            continue;
        }

        const expected = expectedWireType(field);
        if (wireType !== expected && !(wireType === 2 && isPackable(field))) {
            issues.push({
                path: `${path}.${field.name}`,
                fieldNumber,
                message: `wire type 为 ${wireType}，proto 定义需要 ${expected}`,
            });
            skipField(reader, wireType);
            continue;
        }

        if (wireType === 2 && field.resolvedType instanceof protobuf.Type && !field.map) {
            const nested = reader.bytes();
            auditType(field.resolvedType, nested, `${path}.${field.name}`, issues);
            continue;
        }
        skipField(reader, wireType);
    }
}

export function auditProtobufMessage(type: protobuf.Type, buffer: Uint8Array): ProtobufAuditIssue[] {
    const issues: ProtobufAuditIssue[] = [];
    try {
        auditType(type, buffer, type.fullName || type.name, issues);
    } catch (error) {
        issues.push({
            path: type.fullName || type.name,
            fieldNumber: 0,
            message: `wire 数据无法完整扫描：${error instanceof Error ? error.message : String(error)}`,
        });
    }
    return issues;
}
