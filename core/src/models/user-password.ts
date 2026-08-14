import crypto from 'node:crypto';

const SALT_LENGTH = 32;
const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const DIGEST = 'sha512';

export interface PasswordStrengthResult {
    valid: boolean;
    errors: string[];
}

export function validatePasswordStrength(passwordValue: unknown): PasswordStrengthResult {
    const password = String(passwordValue || '');
    const errors: string[] = [];
    if (password.length < 6) errors.push('密码长度至少6位');
    if (password.length > 128) errors.push('密码长度不能超过128位');

    let typeCount = 0;
    if (/[a-z]/.test(password)) typeCount += 1;
    if (/[A-Z]/.test(password)) typeCount += 1;
    if (/\d/.test(password)) typeCount += 1;
    if (/[!@#$%^&*(),.?":{}|<>_\-+=[\]\\;'/`~]/.test(password)) typeCount += 1;
    if (typeCount < 2) {
        errors.push('密码必须包含大写字母、小写字母、数字、特殊符号中的至少两种');
    }

    const commonPasswords = ['password', '123456', 'qwerty', 'abc123', '111111', '000000'];
    if (commonPasswords.includes(password.toLowerCase())) {
        errors.push('密码过于简单，请使用更复杂的密码');
    }
    return { valid: errors.length === 0, errors };
}

export function hashPassword(passwordValue: unknown, saltValue: unknown = null): string {
    const password = String(passwordValue || '');
    const salt = saltValue ? String(saltValue) : crypto.randomBytes(SALT_LENGTH).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
    return `${salt}:${hash}`;
}

export function verifyPassword(passwordValue: unknown, storedPasswordValue: unknown): boolean {
    const password = String(passwordValue || '');
    const storedPassword = String(storedPasswordValue || '');
    if (storedPassword.includes(':')) {
        const [salt, hash] = storedPassword.split(':');
        if (!salt || !hash) return false;
        const actual = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
        const expected = Buffer.from(hash, 'hex');
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    }
    const legacyHash = crypto.createHash('sha256').update(password).digest('hex');
    const actual = Buffer.from(legacyHash, 'hex');
    const expected = Buffer.from(storedPassword, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function needsRehash(storedPasswordValue: unknown): boolean {
    return !String(storedPasswordValue || '').includes(':');
}

export function generateCardCode(random: () => number = Math.random): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let index = 0; index < 16; index += 1) {
        code += chars.charAt(Math.floor(random() * chars.length));
    }
    return code;
}
