import type { LogEntry } from '../types/domain';

export interface AuthenticatedUser {
    role?: string;
    username?: string;
}

export interface OwnedAccount {
    username?: string;
}

export function canAccessAccount(
    user: AuthenticatedUser | null | undefined,
    account: OwnedAccount | null | undefined,
): boolean {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (!account) return false;
    return String(account.username || '') === String(user.username || '');
}

export function filterLogsByAccountIds(
    logs: readonly LogEntry[] | unknown,
    accountIds: Iterable<unknown> | null | undefined,
    includeSystemLogs = false,
): LogEntry[] {
    const list: readonly unknown[] = Array.isArray(logs) ? logs : [];
    const allowed = new Set(Array.from(accountIds || [], id => String(id || '')).filter(Boolean));
    return list.filter((entry): entry is LogEntry => {
        if (!entry || typeof entry !== 'object') return false;
        const logEntry = entry as LogEntry;
        const accountId = String(logEntry.accountId || logEntry.id || '');
        if (!accountId) return includeSystemLogs;
        return allowed.has(accountId);
    });
}
