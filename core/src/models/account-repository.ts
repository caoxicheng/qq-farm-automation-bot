import { ensureDataDir, getDataFile } from '../config/runtime-paths';
import { readJsonFile, writeJsonFileAtomic } from '../services/json-db';

export interface StoredAccount extends Record<string, unknown> {
    id?: unknown;
}

export interface AccountsData {
    accounts: StoredAccount[];
    nextId: number;
}

export interface AccountRepositoryDependencies {
    ensureDataDir: () => string;
    getDataFile: (filename: string) => string;
    readJsonFile: typeof readJsonFile;
    writeJsonFileAtomic: typeof writeJsonFileAtomic;
}

export interface AccountRepository {
    loadAccounts: () => AccountsData;
    saveAccounts: (data: unknown) => void;
}

function isStoredAccount(value: unknown): value is StoredAccount {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAccountsData(raw: unknown): AccountsData {
    const data = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
    const accounts = Array.isArray(data.accounts)
        ? data.accounts.filter(isStoredAccount)
        : [];
    const maxId = accounts.reduce(
        (maximum, account) => Math.max(maximum, Number.parseInt(String(account.id), 10) || 0),
        0,
    );
    let nextId = Number.parseInt(String(data.nextId), 10);
    if (!Number.isFinite(nextId) || nextId <= 0) nextId = maxId + 1;
    if (accounts.length === 0) nextId = 1;
    if (nextId <= maxId) nextId = maxId + 1;
    return { accounts, nextId };
}

export function createAccountRepository(
    dependencies: AccountRepositoryDependencies = {
        ensureDataDir,
        getDataFile,
        readJsonFile,
        writeJsonFileAtomic,
    },
): AccountRepository {
    const accountsFile = dependencies.getDataFile('accounts.json');
    return {
        loadAccounts(): AccountsData {
            dependencies.ensureDataDir();
            const data = dependencies.readJsonFile<unknown>(
                accountsFile,
                () => ({ accounts: [], nextId: 1 }),
            );
            return normalizeAccountsData(data);
        },
        saveAccounts(data: unknown): void {
            dependencies.ensureDataDir();
            dependencies.writeJsonFileAtomic(accountsFile, normalizeAccountsData(data));
        },
    };
}
