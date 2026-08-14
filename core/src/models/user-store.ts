import crypto from 'node:crypto';
import { ensureDataDir, getDataFile } from '../config/runtime-paths';
import { readJsonFile, writeJsonFileAtomic } from '../services/json-db';
import { createLoginSecurityService } from './login-security';
import { createUserDataRepository  } from './user-data-repository';
import type {DataRecord} from './user-data-repository';
import {
    generateCardCode,
    hashPassword,
    needsRehash,
    validatePasswordStrength,
    verifyPassword,
} from './user-password';

type CardType = 'time' | 'quota';

interface UserCard extends DataRecord {
    code?: string;
    description?: string;
    days?: number;
    expiresAt?: number | null;
    enabled?: boolean;
}

interface StoredUser extends DataRecord {
    username: string;
    password: string;
    role: string;
    cardCode?: string;
    card?: UserCard | null;
    accountLimit?: number;
    createdAt?: number;
    mustChangePassword?: boolean;
}

interface StoredCard extends DataRecord {
    code: string;
    description: string;
    days: number;
    type: CardType;
    enabled: boolean;
    usedBy: string | null;
    usedAt: number | null;
    createdAt: number;
}

interface CardClaimRecord extends DataRecord {
    uaHash: string;
    claimTime: number;
    cardCode?: string;
    username?: string | null;
}

function asRecord(value: unknown): DataRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as DataRecord
        : {};
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function normalizeUserCard(value: unknown): UserCard | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const source = value as DataRecord;
    const expiresAt = source.expiresAt === null
        ? null
        : (Number.isFinite(Number(source.expiresAt)) ? Number(source.expiresAt) : undefined);
    return {
        ...source,
        ...(source.code !== undefined ? { code: String(source.code) } : {}),
        ...(source.description !== undefined ? { description: String(source.description) } : {}),
        ...(Number.isFinite(Number(source.days)) ? { days: Number(source.days) } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(source.enabled !== undefined ? { enabled: Boolean(source.enabled) } : {}),
    };
}

function normalizeUsers(records: readonly DataRecord[]): StoredUser[] {
    const normalized: StoredUser[] = [];
    for (const record of records) {
        const username = typeof record.username === 'string' ? record.username : '';
        const password = typeof record.password === 'string' ? record.password : '';
        if (!username || !password) continue;
        const accountLimit = Number(record.accountLimit);
        normalized.push({
            ...record,
            username,
            password,
            role: typeof record.role === 'string' ? record.role : 'user',
            ...(record.cardCode !== undefined ? { cardCode: String(record.cardCode) } : {}),
            ...(record.card !== undefined ? { card: normalizeUserCard(record.card) } : {}),
            ...(Number.isFinite(accountLimit) ? { accountLimit } : {}),
            ...(record.mustChangePassword !== undefined
                ? { mustChangePassword: Boolean(record.mustChangePassword) }
                : {}),
        });
    }
    return normalized;
}

function normalizeCards(records: readonly DataRecord[]): StoredCard[] {
    const normalized: StoredCard[] = [];
    for (const record of records) {
        const code = String(record.code || '').trim();
        if (!code) continue;
        const days = Number.parseInt(String(record.days), 10);
        const usedAt = Number(record.usedAt);
        normalized.push({
            ...record,
            code,
            description: String(record.description || ''),
            days: Number.isFinite(days) ? days : 30,
            type: record.type === 'quota' ? 'quota' : 'time',
            enabled: Boolean(record.enabled),
            usedBy: record.usedBy ? String(record.usedBy) : null,
            usedAt: Number.isFinite(usedAt) ? usedAt : null,
            createdAt: Number(record.createdAt) || 0,
        });
    }
    return normalized;
}

function normalizeCardClaimRecords(records: readonly DataRecord[]): CardClaimRecord[] {
    const normalized: CardClaimRecord[] = [];
    for (const record of records) {
        const uaHash = String(record.uaHash || '').trim();
        const claimTime = Number(record.claimTime);
        if (!uaHash || !Number.isFinite(claimTime)) continue;
        normalized.push({
            ...record,
            uaHash,
            claimTime,
            ...(record.cardCode !== undefined ? { cardCode: String(record.cardCode) } : {}),
            username: record.username ? String(record.username) : null,
        });
    }
    return normalized;
}

const loginSecurity = createLoginSecurityService({
    ensureDataDir,
    getDataFile,
    readJsonFile,
    writeJsonFileAtomic,
});
const {
    addLoginLog,
    checkAccountLockout,
    checkRateLimit,
    clearFailedAttempts,
    clearLoginLogs,
    getLoginLogs,
    loadLoginAttempts,
    recordFailedAttempt,
} = loginSecurity;
const userDataRepository = createUserDataRepository({
    ensureDataDir,
    getDataFile,
    readJsonFile,
    writeJsonFileAtomic,
});

const DEFAULT_ACCOUNT_LIMIT = 2;

let cardClaimEnabled = false;
let cardClaimRecords: CardClaimRecord[] = [];

let users: StoredUser[] = [];
let cards: StoredCard[] = [];

function loadUsers(): void {
    try {
        users = normalizeUsers(userDataRepository.loadUsers());
    } catch (e) {
        console.error('加载用户数据失败:', errorMessage(e));
        users = [];
    }
}

function saveUsers(): void {
    try {
        userDataRepository.saveUsers(users);
    } catch (e) {
        console.error('保存用户数据失败:', errorMessage(e));
    }
}

function loadCards(): void {
    try {
        cards = normalizeCards(userDataRepository.loadCards());
    } catch (e) {
        console.error('加载卡密数据失败:', errorMessage(e));
        cards = [];
    }
}

function saveCards(): void {
    try {
        userDataRepository.saveCards(cards);
    } catch (e) {
        console.error('保存卡密数据失败:', errorMessage(e));
    }
}

function initDefaultAdmin(): void {
    loadUsers();
    const adminExists = users.find(u => u.username === 'admin');
    if (!adminExists) {
        const defaultPassword = 'admin';
        users.push({
            username: 'admin',
            password: hashPassword(defaultPassword),
            role: 'admin',
            createdAt: Date.now()
        });
        saveUsers();
        console.log('[用户系统] 已创建默认管理员账号，默认密码: admin');
    }
}

function validateUser(usernameValue: unknown, password: unknown, ip: unknown = 'unknown') {
    const username = String(usernameValue || '');
    loadUsers();
    loadLoginAttempts();
    
    const rateLimitResult = checkRateLimit(ip);
    if (!rateLimitResult.allowed) {
        return { 
            error: 'rate_limit', 
            message: rateLimitResult.message,
            remainingMs: rateLimitResult.remainingMs
        };
    }
    
    const lockoutResult = checkAccountLockout(username);
    if (lockoutResult.locked) {
        return { 
            error: 'locked', 
            message: lockoutResult.message,
            remainingMs: lockoutResult.remainingMs
        };
    }
    
    const user = users.find(u => u.username === username);
    if (!user) {
        recordFailedAttempt(username);
        return { error: 'invalid_credentials', message: '用户名或密码错误' };
    }
    
    if (!verifyPassword(password, user.password)) {
        const attemptResult = recordFailedAttempt(username);
        if (attemptResult.locked) {
            return { 
                error: 'locked', 
                message: attemptResult.message 
            };
        }
        return { 
            error: 'invalid_credentials', 
            message: `用户名或密码错误，剩余尝试次数: ${attemptResult.remainingAttempts}` 
        };
    }
    
    clearFailedAttempts(username);
    
    if (needsRehash(user.password)) {
        user.password = hashPassword(password);
        saveUsers();
        console.log(`[安全] 用户 ${username} 密码已升级为新哈希算法`);
    }
    
    return {
        username: user.username,
        role: user.role,
        cardCode: user.cardCode || null,
        card: user.card || null,
        accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT
    };
}

function registerUser(usernameValue: unknown, password: unknown, cardCodeValue: unknown) {
    const username = String(usernameValue || '');
    const cardCode = String(cardCodeValue || '');
    loadUsers();
    loadCards();

    if (!username || username.length < 3 || username.length > 32) {
        return { ok: false, error: '用户名长度需在3-32位之间' };
    }

    if (!/^\w+$/.test(username)) {
        return { ok: false, error: '用户名只能包含字母、数字和下划线' };
    }

    if (users.find(u => u.username === username)) {
        return { ok: false, error: '用户名已存在' };
    }

    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
        return { ok: false, error: passwordValidation.errors.join('；') };
    }

    const card = cards.find(c => c.code === cardCode);
    if (!card) {
        return { ok: false, error: '卡密不存在' };
    }

    if (!card.enabled) {
        return { ok: false, error: '卡密已被禁用' };
    }

    if (card.usedBy) {
        return { ok: false, error: '卡密已被使用' };
    }

    const cardType = card.type || 'time';
    if (cardType === 'quota') {
        return { ok: false, error: '注册只能使用时间卡密，额度卡密请登录后在续费中使用' };
    }

    const now = Date.now();
    
    const newUser = {
        username,
        password: hashPassword(password),
        role: 'user',
        cardCode,
        card: {
            code: card.code,
            description: card.description,
            days: card.days,
            expiresAt: card.days === -1 ? null : (now + card.days * 24 * 60 * 60 * 1000),
            enabled: true
        },
        accountLimit: DEFAULT_ACCOUNT_LIMIT,
        createdAt: now
    };

    users.push(newUser);
    card.usedBy = username;
    card.usedAt = now;

    saveUsers();
    saveCards();
    
    clearFailedAttempts(username);

    return { ok: true, user: { username: newUser.username, role: newUser.role, card: newUser.card, accountLimit: newUser.accountLimit } };
}

function renewUser(usernameValue: unknown, cardCodeValue: unknown) {
    const username = String(usernameValue || '');
    const cardCode = String(cardCodeValue || '');
    loadUsers();
    loadCards();

    const user = users.find(u => u.username === username);
    if (!user) {
        return { ok: false, error: '用户不存在' };
    }

    const card = cards.find(c => c.code === cardCode);
    if (!card) {
        return { ok: false, error: '卡密不存在' };
    }

    if (!card.enabled) {
        return { ok: false, error: '卡密已被禁用' };
    }

    if (card.usedBy) {
        return { ok: false, error: '卡密已被使用' };
    }

    const now = Date.now();
    const cardType = card.type || 'time';
    
    if (cardType === 'quota') {
        // 额度卡密：增加账号额度
        const currentLimit = user.accountLimit || DEFAULT_ACCOUNT_LIMIT;
        user.accountLimit = currentLimit + card.days;
    } else {
        // 时间卡密：增加使用时长
        // 确保用户有card对象
        if (!user.card) {
            user.card = {
                code: card.code,
                description: card.description,
                days: 0,
                expiresAt: null,
                enabled: true
            };
        }
        
        const currentExpires = user.card.expiresAt || 0;
        const currentDays = user.card.days || 0;
        
        // days为-1表示永久
        if (card.days === -1) {
            // 永久卡，设置为永久
            user.card.expiresAt = null;
            user.card.days = -1;
        } else if (user.card.days === -1) {
            // 已经是永久，保持永久
            user.card.expiresAt = null;
        } else {
            // 累加天数
            user.card.days = currentDays + card.days;
            
            // 计算新的过期时间
            if (currentExpires && currentExpires > now) {
                // 未过期，在当前过期时间基础上增加
                user.card.expiresAt = currentExpires + card.days * 24 * 60 * 60 * 1000;
            } else {
                // 已过期或无过期时间，从现在开始计算
                user.card.expiresAt = now + card.days * 24 * 60 * 60 * 1000;
            }
        }
    }

    // 标记卡密已使用
    card.usedBy = username;
    card.usedAt = now;

    saveUsers();
    saveCards();

    return { ok: true, card: user.card, accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT, cardType };
}

function getAllUsers() {
    loadUsers();
    return users.map(u => ({
        username: u.username,
        role: u.role,
        card: u.card,
        accountLimit: u.accountLimit || DEFAULT_ACCOUNT_LIMIT
    }));
}

function updateUser(usernameValue: unknown, updates: unknown) {
    const username = String(usernameValue || '');
    const source = asRecord(updates);
    loadUsers();
    const user = users.find(u => u.username === username);
    if (!user) return null;

    if (source.expiresAt !== undefined) {
        if (!user.card) user.card = {};
        user.card.expiresAt = source.expiresAt === null ? null : Number(source.expiresAt);
    }

    if (source.enabled !== undefined) {
        if (!user.card) user.card = {};
        user.card.enabled = Boolean(source.enabled);
    }

    saveUsers();

    return { username: user.username, role: user.role, card: user.card, accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT };
}

function editUser(oldUsernameValue: unknown, updates: unknown) {
    const oldUsername = String(oldUsernameValue || '');
    const source = asRecord(updates);
    loadUsers();
    
    const user = users.find(u => u.username === oldUsername);
    if (!user) {
        return { ok: false, error: '用户不存在' };
    }

    const newUsername = source.newUsername ? String(source.newUsername) : '';
    if (newUsername && newUsername !== oldUsername) {
        if (!/^\w{3,32}$/.test(newUsername)) {
            return { ok: false, error: '用户名只能包含字母、数字和下划线，长度3-32位' };
        }
        const existingUser = users.find(u => u.username === newUsername);
        if (existingUser) {
            return { ok: false, error: '用户名已存在' };
        }
        user.username = newUsername;
    }

    if (source.password) {
        const password = String(source.password);
        const passwordValidation = validatePasswordStrength(password);
        if (!passwordValidation.valid) {
            return { ok: false, error: passwordValidation.errors.join('；') };
        }
        user.password = hashPassword(password);
    }

    if (source.accountLimit !== undefined) {
        user.accountLimit = Number.parseInt(String(source.accountLimit), 10) || DEFAULT_ACCOUNT_LIMIT;
    }

    if (source.isPermanent) {
        if (!user.card) user.card = {};
        user.card.days = -1;
        user.card.expiresAt = null;
    } else if (source.expiresAt !== undefined) {
        if (!user.card) user.card = {};
        if (source.expiresAt === null) {
            user.card.days = 0;
            user.card.expiresAt = null;
        } else {
            const now = Date.now();
            const expiresAt = Number.parseInt(String(source.expiresAt), 10);
            user.card.expiresAt = expiresAt;
            const diffMs = expiresAt - now;
            const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
            user.card.days = diffDays > 0 ? diffDays : 0;
        }
    }

    saveUsers();

    return { 
        ok: true, 
        user: { 
            username: user.username, 
            role: user.role, 
            card: user.card, 
            accountLimit: user.accountLimit || DEFAULT_ACCOUNT_LIMIT 
        } 
    };
}

function getAllCards(): StoredCard[] {
    loadCards();
    return cards;
}

function createCard(descriptionValue: unknown, daysValue: unknown, type: unknown = 'time'): StoredCard {
    loadCards();
    const description = String(descriptionValue || '');

    const newCard: StoredCard = {
        code: generateCardCode(),
        description,
        days: Number.parseInt(String(daysValue), 10) || 30,
        type: type === 'quota' ? 'quota' : 'time',
        enabled: true,
        usedBy: null,
        usedAt: null,
        createdAt: Date.now()
    };

    cards.push(newCard);
    saveCards();

    return newCard;
}

function createCardsBatch(
    descriptionValue: unknown,
    daysValue: unknown,
    countValue: unknown,
    type: unknown = 'time',
): StoredCard[] {
    loadCards();

    const description = String(descriptionValue || '');
    const createdCards: StoredCard[] = [];
    const daysNum = Number.parseInt(String(daysValue), 10) || 30;
    const countNum = Math.min(Math.max(Number.parseInt(String(countValue), 10) || 1, 1), 100);
    const cardType: CardType = type === 'quota' ? 'quota' : 'time';

    for (let i = 0; i < countNum; i++) {
        const newCard: StoredCard = {
            code: generateCardCode(),
            description,
            days: daysNum,
            type: cardType,
            enabled: true,
            usedBy: null,
            usedAt: null,
            createdAt: Date.now()
        };
        cards.push(newCard);
        createdCards.push(newCard);
    }

    saveCards();

    return createdCards;
}

function updateCard(codeValue: unknown, updates: unknown): StoredCard | null {
    const code = String(codeValue || '');
    const source = asRecord(updates);
    loadCards();
    const card = cards.find(c => c.code === code);
    if (!card) return null;

    if (source.description !== undefined) {
        card.description = String(source.description);
    }

    if (source.enabled !== undefined) {
        card.enabled = Boolean(source.enabled);
    }

    saveCards();
    return card;
}

function deleteCard(codeValue: unknown): boolean {
    const code = String(codeValue || '');
    loadCards();
    const idx = cards.findIndex(c => c.code === code);
    if (idx === -1) return false;

    cards.splice(idx, 1);
    saveCards();
    return true;
}

function deleteCardsBatch(codes: unknown) {
    loadCards();
    if (!Array.isArray(codes) || codes.length === 0) {
        return { ok: false, error: '请提供要删除的卡密列表' };
    }

    let deletedCount = 0;
    const notFoundCodes: unknown[] = [];

    for (const code of codes) {
        const idx = cards.findIndex(c => c.code === code);
        if (idx !== -1) {
            cards.splice(idx, 1);
            deletedCount++;
        } else {
            notFoundCodes.push(code);
        }
    }

    saveCards();
    return {
        ok: true,
        deletedCount,
        notFoundCount: notFoundCodes.length,
        notFoundCodes: notFoundCodes.length > 0 ? notFoundCodes : undefined
    };
}

function deleteUser(usernameValue: unknown, forceDeleteAdmin = false) {
    const username = String(usernameValue || '');
    loadUsers();
    const idx = users.findIndex(u => u.username === username);
    if (idx === -1) return { ok: false, error: '用户不存在' };

    // 不允许删除管理员账号（除非强制删除）
    if (!forceDeleteAdmin && users[idx].role === 'admin') {
        return { ok: false, error: '不能删除管理员账号' };
    }

    users.splice(idx, 1);
    saveUsers();
    return { ok: true };
}

function changePassword(usernameValue: unknown, oldPassword: unknown, newPassword: unknown) {
    const username = String(usernameValue || '');
    loadUsers();
    const user = users.find(u => u.username === username);
    if (!user) {
        return { ok: false, error: '用户不存在' };
    }

    if (!verifyPassword(oldPassword, user.password)) {
        return { ok: false, error: '当前密码错误' };
    }

    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.valid) {
        return { ok: false, error: passwordValidation.errors.join('；') };
    }

    user.password = hashPassword(newPassword);
    if (user.mustChangePassword) {
        delete user.mustChangePassword;
    }

    saveUsers();
    return { ok: true, message: '密码修改成功' };
}

initDefaultAdmin();

// ============ 卡密领取功能 ============
function loadCardClaimRecords(): void {
    try {
        const data = userDataRepository.loadCardClaims();
        cardClaimEnabled = data.enabled;
        cardClaimRecords = normalizeCardClaimRecords(data.records);
    } catch {
        cardClaimEnabled = true;
        cardClaimRecords = [];
    }
}

function saveCardClaimRecords(): void {
    try {
        userDataRepository.saveCardClaims({
            enabled: cardClaimEnabled,
            records: cardClaimRecords,
        });
    } catch {
        // console.error('保存卡密领取记录失败:', e.message);
    }
}

function getCardClaimStatus(): { enabled: boolean } {
    loadCardClaimRecords();
    return { enabled: cardClaimEnabled };
}

function setCardClaimStatus(enabled: unknown): { enabled: boolean } {
    loadCardClaimRecords();
    cardClaimEnabled = !!enabled;
    saveCardClaimRecords();
    return { enabled: cardClaimEnabled };
}

function checkUAClaimLimit(uaValue: unknown) {
    loadCardClaimRecords();
    const now = Date.now();
    const ua = String(uaValue || '');
    const uaHash = crypto.createHash('sha256').update(ua).digest('hex');
    
    const record = cardClaimRecords.find(r => r.uaHash === uaHash);
    if (record) {
        const elapsed = now - record.claimTime;
        if (elapsed < 24 * 60 * 60 * 1000) {
            const remainingMs = 24 * 60 * 60 * 1000 - elapsed;
            return {
                allowed: false,
                remainingMs,
                message: '您已经在24小时内领取过一次卡密了！'
            };
        }
    }
    
    return { allowed: true };
}

function claimCardByUA(uaValue: unknown, usernameValue: unknown = null) {
    loadCards();
    loadCardClaimRecords();
    const ua = String(uaValue || '');
    const username = usernameValue ? String(usernameValue) : null;
    
    if (!cardClaimEnabled) {
        return { ok: false, error: '卡密领取功能未开启' };
    }
    
    const uaCheck = checkUAClaimLimit(ua);
    if (!uaCheck.allowed) {
        return { ok: false, error: uaCheck.message, remainingMs: uaCheck.remainingMs };
    }
    
    const unusedTimeCards = cards.filter(c => 
        c.type === 'time' && 
        !c.usedBy && 
        c.enabled
    );
    
    if (unusedTimeCards.length === 0) {
        return { ok: false, error: '卡密库存不足，请联系管理员！' };
    }
    
    const randomIndex = Math.floor(Math.random() * unusedTimeCards.length);
    const selectedCard = unusedTimeCards[randomIndex];
    
    const uaHash = crypto.createHash('sha256').update(ua).digest('hex');
    cardClaimRecords.push({
        uaHash,
        claimTime: Date.now(),
        cardCode: selectedCard.code,
        username: username || null
    });
    
    saveCardClaimRecords();
    
    return {
        ok: true,
        cardCode: selectedCard.code,
        days: selectedCard.days,
        description: selectedCard.description
    };
}

function getCardClaimRecords(): CardClaimRecord[] {
    loadCardClaimRecords();
    return cardClaimRecords;
}

function clearExpiredClaimRecords(): { cleared: number } {
    loadCardClaimRecords();
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    
    const beforeCount = cardClaimRecords.length;
    cardClaimRecords = cardClaimRecords.filter(r => 
        now - r.claimTime < oneDayMs
    );
    
    if (cardClaimRecords.length !== beforeCount) {
        saveCardClaimRecords();
    }
    
    return { cleared: beforeCount - cardClaimRecords.length };
}

module.exports = {
    validateUser,
    registerUser,
    renewUser,
    getAllUsers,
    updateUser,
    editUser,
    getAllCards,
    createCard,
    createCardsBatch,
    updateCard,
    deleteCard,
    deleteCardsBatch,
    deleteUser,
    changePassword,
    DEFAULT_ACCOUNT_LIMIT,
    addLoginLog,
    getLoginLogs,
    clearLoginLogs,
    getCardClaimStatus,
    setCardClaimStatus,
    claimCardByUA,
    getCardClaimRecords,
    clearExpiredClaimRecords,
};
