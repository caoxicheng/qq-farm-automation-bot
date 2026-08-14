import assert from 'node:assert/strict';
import { RequestQueue } from '../src/services/rate-limiter';
import {
    checkPasswordStrength,
    getClientIp,
    hashPassword,
    rateLimitMiddleware,
    verifyPassword,
} from '../src/services/security';

const test = require('node:test') as typeof import('node:test');

test('请求队列串行执行任务并在失败后继续处理后续请求', async () => {
    const queue = new RequestQueue({ maxConcurrent: 2, minInterval: 1 });
    const order: string[] = [];
    const first = queue.addRequest(async () => {
        order.push('first:start');
        await new Promise<void>(resolve => setTimeout(resolve, 5));
        order.push('first:end');
        return 1;
    });
    const second = queue.addRequest(() => {
        order.push('second');
        return 2;
    });

    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(order, ['first:start', 'first:end', 'second']);

    await assert.rejects(
        queue.addRequest(() => { throw new Error('expected'); }, { retries: 0 }),
        /expected/,
    );
    assert.equal(await queue.addRequest(() => 3), 3);
    assert.deepEqual(queue.getStatus(), {
        queueSize: 0,
        availableTokens: 2,
        capacity: 2,
    });
});

test('安全中间件按可信请求头取 IP 并限制同一客户端请求次数', () => {
    assert.equal(getClientIp({
        headers: {
            'cf-connecting-ip': ' 203.0.113.8 ',
            'x-forwarded-for': '198.51.100.2, 198.51.100.3',
        },
    }), '203.0.113.8');
    assert.equal(getClientIp({
        headers: {},
        socket: { remoteAddress: '::ffff:127.0.0.2' },
    }), '127.0.0.2');

    const responseHeaders: Record<string, string | number> = {};
    let statusCode = 200;
    let responseBody: unknown;
    const response = {
        set(name: string, value: string | number) {
            responseHeaders[name] = value;
            return response;
        },
        status(code: number) {
            statusCode = code;
            return response;
        },
        json(body: unknown) {
            responseBody = body;
            return body;
        },
    };
    let nextCalls = 0;
    const middleware = rateLimitMiddleware({ windowMs: 60_000, maxRequests: 2 });
    const request = { headers: { 'x-real-ip': '198.51.100.7' } };
    middleware(request, response, () => { nextCalls += 1; });
    middleware(request, response, () => { nextCalls += 1; });
    middleware(request, response, () => { nextCalls += 1; });

    assert.equal(nextCalls, 2);
    assert.equal(statusCode, 429);
    assert.equal(responseHeaders['X-RateLimit-Remaining'], 0);
    assert.deepEqual(responseBody, {
        ok: false,
        error: '请求过于频繁，请稍后重试',
        retryAfter: 60,
    });
});

test('安全密码散列可验证且密码强度边界保持稳定', async () => {
    const hash = await hashPassword('Correct-Horse-42');
    assert.equal(await verifyPassword('Correct-Horse-42', hash), true);
    assert.equal(await verifyPassword('wrong', hash), false);
    assert.deepEqual(checkPasswordStrength(''), {
        score: 0,
        valid: false,
        feedback: ['密码不能为空'],
    });
    assert.equal(checkPasswordStrength('Abcd1234!').valid, true);
});
