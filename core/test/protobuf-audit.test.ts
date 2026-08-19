import assert from 'node:assert/strict';
// eslint-disable-next-line test/no-import-node-test -- 项目测试由 Node 内置测试运行器执行
import test from 'node:test';
import protobuf from 'protobufjs';
import { auditProtobufMessage } from '../src/utils/protobuf-audit';

function createType(): protobuf.Type {
    return protobuf.Type.fromJSON('Envelope', {
        fields: {
            id: { type: 'uint32', id: 1 },
            title: { type: 'string', id: 2 },
        },
    });
}

test('protobuf audit accepts fields whose numbers and wire types match', () => {
    const type = createType();
    const buffer = type.encode({ id: 7, title: 'ok' }).finish();
    assert.deepEqual(auditProtobufMessage(type, buffer), []);
});

test('protobuf audit reports unknown fields retained in captured bytes', () => {
    const type = createType();
    const writer = protobuf.Writer.create().uint32(8).uint32(7).uint32(24).uint32(99);
    const issues = auditProtobufMessage(type, writer.finish());
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.fieldNumber, 3);
    assert.match(issues[0]?.message || '', /未在 .*Envelope.* 中定义/);
});

test('protobuf audit reports an incompatible wire type', () => {
    const type = createType();
    const writer = protobuf.Writer.create().uint32(10).string('not-a-varint');
    const issues = auditProtobufMessage(type, writer.finish());
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.fieldNumber, 1);
    assert.match(issues[0]?.message || '', /wire type 为 2.*需要 0/);
});
