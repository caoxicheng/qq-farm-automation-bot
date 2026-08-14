export interface AccountIdentity {
    id?: unknown;
    uin?: unknown;
    qq?: unknown;
    [key: string]: unknown;
}

export function normalizeAccountRef(rawRef: unknown): string {
    if (rawRef === undefined || rawRef === null) return '';
    if (Array.isArray(rawRef)) {
        return normalizeAccountRef(rawRef[0]);
    }
    return String(rawRef).trim();
}

export function buildAccountKeys(account: AccountIdentity | null | undefined): Set<string> {
    const keys = new Set<string>();
    const push = (value: unknown) => {
        const next = normalizeAccountRef(value);
        if (next) keys.add(next);
    };
    push(account?.id);
    push(account?.uin);
    push(account?.qq);
    return keys;
}

export function findAccountByRef<T extends AccountIdentity = AccountIdentity>(
    accounts: readonly T[] | unknown,
    rawRef: unknown,
): T | null {
    const key = normalizeAccountRef(rawRef);
    if (!key) return null;

    const list: readonly unknown[] = Array.isArray(accounts) ? accounts : [];
    for (const account of list) {
        if (!account || typeof account !== 'object') continue;
        const identity = account as T;
        if (buildAccountKeys(identity).has(key)) {
            return identity;
        }
    }
    return null;
}

export function resolveAccountId(accounts: readonly AccountIdentity[] | unknown, rawRef: unknown): string {
    const found = findAccountByRef(accounts, rawRef);
    if (!found) return '';
    return normalizeAccountRef(found.id);
}
