import * as fs from 'node:fs';
import { ensureDataDir, getDataFile } from '../config/runtime-paths';
import { readJsonFile, writeJsonFileAtomic } from '../services/json-db';

export type DataRecord = Record<string, unknown>;

export interface CardClaimData {
    enabled: boolean;
    records: DataRecord[];
}

export interface UserDataRepositoryDependencies {
    ensureDataDir: () => string;
    getDataFile: (filename: string) => string;
    readJsonFile: typeof readJsonFile;
    writeJsonFileAtomic: typeof writeJsonFileAtomic;
    existsSync?: typeof fs.existsSync;
}

export interface UserDataRepository {
    loadUsers: () => DataRecord[];
    saveUsers: (users: readonly DataRecord[]) => void;
    loadCards: () => DataRecord[];
    saveCards: (cards: readonly DataRecord[]) => void;
    loadCardClaims: () => CardClaimData;
    saveCardClaims: (data: CardClaimData) => void;
}

function recordArray(value: unknown): DataRecord[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is DataRecord => Boolean(
        item && typeof item === 'object' && !Array.isArray(item),
    ));
}

export function createUserDataRepository(
    dependencies: UserDataRepositoryDependencies = {
        ensureDataDir,
        getDataFile,
        readJsonFile,
        writeJsonFileAtomic,
        existsSync: fs.existsSync,
    },
): UserDataRepository {
    const usersFile = dependencies.getDataFile('users.json');
    const cardsFile = dependencies.getDataFile('cards.json');
    const cardClaimsFile = dependencies.getDataFile('card-claim.json');
    const existsSync = dependencies.existsSync || fs.existsSync;

    const loadCollection = (filePath: string, key: string, saveEmpty: () => void) => {
        dependencies.ensureDataDir();
        const existed = existsSync(filePath);
        const data = dependencies.readJsonFile<Record<string, unknown>>(filePath, () => ({}));
        const values = recordArray(data[key]);
        if (!existed) saveEmpty();
        return values;
    };

    const repository: UserDataRepository = {
        loadUsers: () => loadCollection(usersFile, 'users', () => repository.saveUsers([])),
        saveUsers(users) {
            dependencies.ensureDataDir();
            dependencies.writeJsonFileAtomic(usersFile, { users: recordArray(users) });
        },
        loadCards: () => loadCollection(cardsFile, 'cards', () => repository.saveCards([])),
        saveCards(cards) {
            dependencies.ensureDataDir();
            dependencies.writeJsonFileAtomic(cardsFile, { cards: recordArray(cards) });
        },
        loadCardClaims() {
            dependencies.ensureDataDir();
            const fallback = { fallback: true };
            const data = dependencies.readJsonFile<Record<string, unknown>>(cardClaimsFile, () => fallback);
            const result = data === fallback
                ? { enabled: true, records: [] }
                : { enabled: data.enabled === true, records: recordArray(data.records) };
            if (!existsSync(cardClaimsFile)) repository.saveCardClaims(result);
            return result;
        },
        saveCardClaims(data) {
            dependencies.ensureDataDir();
            dependencies.writeJsonFileAtomic(cardClaimsFile, {
                enabled: Boolean(data.enabled),
                records: recordArray(data.records),
            });
        },
    };
    return repository;
}
