/**
 * 请求队列与并发控制模块
 * 解决批量操作无并发限制的问题，防止触发服务端限流
 */

import { createModuleLogger } from './logger';

export interface RequestQueueOptions {
    maxConcurrent?: number;
    minInterval?: number;
    maxRetries?: number;
    retryDelay?: number;
    enableBurst?: boolean;
    burstSize?: number;
}

interface TokenBucketOptions {
    capacity?: number;
    refillRate?: number;
    maxWait?: number;
}

interface RequestOptions {
    priority?: number;
    retries?: number;
    label?: string;
}

interface QueueTask {
    fn: () => unknown | Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    retries: number;
    label: string;
    attempts: number;
    priority?: number;
}

interface QueueStatus {
    queueSize: number;
    availableTokens: number;
    capacity: number;
}

export interface FarmOperation {
    type: string;
    landId: unknown;
    fn: (landIds: unknown[]) => unknown | Promise<unknown>;
}

export interface FriendOperation {
    friendId: unknown;
    params: unknown;
    fn: (params: unknown) => unknown | Promise<unknown>;
    priority?: number;
    label?: string;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const logger = createModuleLogger('rate-limiter');

const DEFAULT_CONFIG: Required<RequestQueueOptions> = {
    maxConcurrent: 3,
    minInterval: 100,
    maxRetries: 2,
    retryDelay: 500,
    enableBurst: false,
    burstSize: 5,
};

class TokenBucket {
    capacity: number;
    tokens: number;
    refillRate: number;
    lastRefill: number;
    maxWait: number;

    constructor(options: TokenBucketOptions = {}) {
        this.capacity = options.capacity || DEFAULT_CONFIG.maxConcurrent;
        this.tokens = this.capacity;
        this.refillRate = options.refillRate || 1000;
        this.lastRefill = Date.now();
        this.maxWait = options.maxWait || 5000;
    }

    refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const tokensToAdd = (elapsed / this.refillRate) * this.capacity;
        this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
        this.lastRefill = now;
    }

    async acquire(tokens = 1): Promise<true> {
        const startWait = Date.now();
        
        while (this.tokens < tokens) {
            if (Date.now() - startWait > this.maxWait) {
                throw new Error('请求等待超时');
            }
            this.refill();
            await sleep(50);
        }
        
        this.tokens -= tokens;
        return true;
    }

    release(tokens = 1): void {
        this.tokens = Math.min(this.capacity, this.tokens + tokens);
    }
}

class PriorityQueue<T> {
    private queue: Array<{ item: T; priority: number; addedAt: number }>;

    constructor() {
        this.queue = [];
    }

    enqueue(item: T, priority = 0): void {
        const entry = { item, priority, addedAt: Date.now() };
        const index = this.queue.findIndex(entry => entry.priority < priority);
        if (index === -1) {
            this.queue.push(entry);
        } else {
            this.queue.splice(index, 0, entry);
        }
    }

    dequeue(): T | undefined {
        return this.queue.shift()?.item;
    }

    peek(): T | undefined {
        return this.queue[0]?.item;
    }

    size(): number {
        return this.queue.length;
    }

    clear(): void {
        this.queue = [];
    }
}

class RequestQueue {
    private readonly bucket: TokenBucket;
    private readonly queue: PriorityQueue<QueueTask>;
    private processing: boolean;
    private readonly config: Required<RequestQueueOptions>;

    constructor(options: RequestQueueOptions = {}) {
        this.bucket = new TokenBucket({
            capacity: options.maxConcurrent || DEFAULT_CONFIG.maxConcurrent,
            refillRate: options.minInterval || DEFAULT_CONFIG.minInterval,
        });
        this.queue = new PriorityQueue();
        this.processing = false;
        this.config = { ...DEFAULT_CONFIG, ...options };
    }

    async addRequest<T>(fn: () => T | Promise<T>, options: RequestOptions = {}): Promise<T> {
        const { priority = 0, retries = DEFAULT_CONFIG.maxRetries, label = 'request' } = options;
        
        return new Promise<T>((resolve, reject) => {
            const task: QueueTask = {
                fn,
                resolve: value => resolve(value as T),
                reject,
                retries,
                label,
                attempts: 0,
            };
            this.queue.enqueue(task, -priority);
            void this.processQueue();
        });
    }

    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.size() === 0) return;
        this.processing = true;

        while (this.queue.size() > 0) {
            const task = this.queue.dequeue();
            if (!task) break;

            try {
                await this.bucket.acquire();
                const result = await this.executeTask(task);
                this.bucket.release();
                task.resolve(result);
            } catch (error) {
                this.bucket.release();
                
                if (task.attempts < task.retries) {
                    task.attempts++;
                    logger.info(`[${task.label}] 请求失败，${task.retries - task.attempts + 1}次重试中...`, { 
                        error: errorMessage(error),
                    });
                    await sleep(this.config.retryDelay * task.attempts);
                    this.queue.enqueue(task, -(task.priority || 0));
                } else {
                    task.reject(error);
                }
            }
        }

        this.processing = false;
    }

    private async executeTask(task: QueueTask): Promise<unknown> {
        return task.fn();
    }

    setConcurrency(concurrency: number): void {
        this.bucket.capacity = Math.max(1, Math.min(concurrency, 20));
    }

    getStatus(): QueueStatus {
        return {
            queueSize: this.queue.size(),
            availableTokens: Math.floor(this.bucket.tokens),
            capacity: this.bucket.capacity,
        };
    }

    clear(): void {
        this.queue.clear();
    }
}

const serviceQueues = new Map<string, RequestQueue>();

function getServiceQueue(serviceName: string, options: RequestQueueOptions = {}): RequestQueue {
    if (!serviceQueues.has(serviceName)) {
        const config = getServiceConfig(serviceName);
        serviceQueues.set(serviceName, new RequestQueue({ ...config, ...options }));
    }
    const queue = serviceQueues.get(serviceName);
    if (!queue) throw new Error(`无法创建请求队列: ${serviceName}`);
    return queue;
}

function getServiceConfig(serviceName: string): RequestQueueOptions {
    const configs: Record<string, RequestQueueOptions> = {
        'PlantService': { maxConcurrent: 2, minInterval: 200 },
        'FriendService': { maxConcurrent: 1, minInterval: 500 },
        'VisitService': { maxConcurrent: 1, minInterval: 500 },
        'TaskService': { maxConcurrent: 3, minInterval: 100 },
        'MallService': { maxConcurrent: 2, minInterval: 200 },
        'default': { maxConcurrent: 3, minInterval: 100 },
    };
    return configs[serviceName] || configs.default || DEFAULT_CONFIG;
}

async function sendWithRetry<T>(
    serviceName: string,
    methodName: string,
    sendFn: () => T | Promise<T>,
    options: RequestOptions & { timeout?: number } = {},
): Promise<T> {
    const queue = getServiceQueue(serviceName);
    const { retries = DEFAULT_CONFIG.maxRetries, timeout = 10000 } = options;
    
    return queue.addRequest(async () => {
        return withTimeout(sendFn(), timeout, `${serviceName}.${methodName} 请求超时`);
    }, {
        label: `${serviceName}.${methodName}`,
        retries,
        priority: options.priority || 0,
    });
}

function withTimeout<T>(promise: T | Promise<T>, ms: number, message: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_resolve, reject) =>
            setTimeout(() => reject(new Error(message)), ms),
        ),
    ]);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class BatchOperationOptimizer {
    private readonly queue: RequestQueue;

    constructor(options: RequestQueueOptions = {}) {
        this.queue = new RequestQueue(options);
    }

    async batchFarmOperations(operations: FarmOperation[]): Promise<Array<{
        success: boolean;
        data?: unknown;
        error?: string;
    }>> {
        const results: Array<{ success: boolean; data?: unknown; error?: string }> = [];
        
        const grouped: Record<'weed' | 'bug' | 'water', FarmOperation[]> = {
            weed: [],
            bug: [],
            water: [],
        };
        
        for (const op of operations) {
            if (op.type === 'weed' || op.type === 'bug' || op.type === 'water') {
                grouped[op.type].push(op);
            }
        }

        const tasks: Array<Promise<unknown>> = [];
        
        if (grouped.weed.length > 0) {
            tasks.push(this.queue.addRequest(async () => {
                return grouped.weed[0].fn(grouped.weed.map(operation => operation.landId));
            }, { priority: 2, label: 'batch_weed' }));
        }
        
        if (grouped.bug.length > 0) {
            tasks.push(this.queue.addRequest(async () => {
                return grouped.bug[0].fn(grouped.bug.map(operation => operation.landId));
            }, { priority: 2, label: 'batch_bug' }));
        }
        
        if (grouped.water.length > 0) {
            tasks.push(this.queue.addRequest(async () => {
                return grouped.water[0].fn(grouped.water.map(operation => operation.landId));
            }, { priority: 2, label: 'batch_water' }));
        }

        const settled = await Promise.allSettled(tasks);
        
        for (const result of settled) {
            if (result.status === 'fulfilled') {
                results.push({ success: true, data: result.value });
            } else {
                results.push({ success: false, error: errorMessage(result.reason) });
            }
        }

        return results;
    }

    async batchFriendOperations(
        operations: FriendOperation[],
        options: { maxConcurrent?: number } = {},
    ): Promise<Array<{ friendId: unknown; success: true; data: unknown }>> {
        const { maxConcurrent = 1 } = options;
        this.queue.setConcurrency(maxConcurrent);
        
        const results: Array<{ friendId: unknown; success: true; data: unknown }> = [];
        
        for (const op of operations) {
            const result = await this.queue.addRequest(async () => {
                return op.fn(op.params);
            }, { 
                priority: op.priority || 0,
                label: op.label || 'friend_op' 
            });
            
            results.push({ 
                friendId: op.friendId, 
                success: true, 
                data: result 
            });
        }

        return results;
    }

    getStatus(): QueueStatus {
        return this.queue.getStatus();
    }
}

let globalFarmOptimizer: BatchOperationOptimizer | null = null;
let globalFriendOptimizer: BatchOperationOptimizer | null = null;

function getFarmOptimizer(): BatchOperationOptimizer {
    if (!globalFarmOptimizer) {
        globalFarmOptimizer = new BatchOperationOptimizer({
            maxConcurrent: 3,
            minInterval: 100,
        });
    }
    return globalFarmOptimizer;
}

function getFriendOptimizer(): BatchOperationOptimizer {
    if (!globalFriendOptimizer) {
        globalFriendOptimizer = new BatchOperationOptimizer({
            maxConcurrent: 1,
            minInterval: 500,
        });
    }
    return globalFriendOptimizer;
}

export {
    BatchOperationOptimizer,
    DEFAULT_CONFIG,
    getFarmOptimizer,
    getFriendOptimizer,
    getServiceQueue,
    PriorityQueue,
    RequestQueue,
    sendWithRetry,
    TokenBucket,
};
