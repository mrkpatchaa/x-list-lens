// Shared across the three worlds (MAIN-world interceptor, content script, service
// worker). Keep page messages and persisted shapes explicit so every trust boundary
// can validate the same contract.

export const MSG = {
    QUERY_HARVESTED: 'X_QUERY_HARVESTED',
    LIST_MUTATION: 'X_LIST_MUTATION',
    START_SYNC: 'START_SYNC',
    CANCEL_SYNC: 'CANCEL_SYNC',
} as const;

export const REQUIRED_OPERATIONS = ['ListsManagementPageTimeline', 'ListMembers'] as const;
export const HARVESTED_OPERATIONS = [
    ...REQUIRED_OPERATIONS,
    'ListAddMember',
    'ListRemoveMember',
] as const;
export const LISTS_URL = 'https://x.com/i/lists';
export const QUERY_ID_STORAGE_PREFIX = 'queryId:';

export type RequiredOperation = typeof REQUIRED_OPERATIONS[number];
export type HarvestedOperation = typeof HARVESTED_OPERATIONS[number];
export type QueryIds = Partial<Record<HarvestedOperation, string>>;

export type QueryHarvestedMessage = {
    type: typeof MSG.QUERY_HARVESTED;
    payload: { operationName: HarvestedOperation; queryId: string };
};

export type ListMutationMessage = {
    type: typeof MSG.LIST_MUTATION;
    payload: { userId: string; listId: string; action: 'add' | 'remove' };
};

const QUERY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const LIST_ID_RE = /^\d{1,32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isValidQueryId(value: unknown): value is string {
    return typeof value === 'string' && QUERY_ID_RE.test(value);
}

export function isValidListId(value: unknown): value is string {
    return typeof value === 'string' && LIST_ID_RE.test(value);
}

function isHarvestedOperation(value: unknown): value is HarvestedOperation {
    return typeof value === 'string' && (HARVESTED_OPERATIONS as readonly string[]).includes(value);
}

export function isQueryHarvestedMessage(value: unknown): value is QueryHarvestedMessage {
    if (!isRecord(value) || value.type !== MSG.QUERY_HARVESTED || !isRecord(value.payload)) return false;
    return isHarvestedOperation(value.payload.operationName) && isValidQueryId(value.payload.queryId);
}

export function isListMutationMessage(value: unknown): value is ListMutationMessage {
    if (!isRecord(value) || value.type !== MSG.LIST_MUTATION || !isRecord(value.payload)) return false;
    return isValidListId(value.payload.listId)
        && isValidListId(value.payload.userId)
        && (value.payload.action === 'add' || value.payload.action === 'remove');
}

export function queryIdStorageKey(operationName: HarvestedOperation): string {
    return `${QUERY_ID_STORAGE_PREFIX}${operationName}`;
}

export function getMissingOperations(queryIds: QueryIds): RequiredOperation[] {
    return REQUIRED_OPERATIONS.filter((operation) => !isValidQueryId(queryIds[operation]));
}

export async function getStoredQueryIds(): Promise<QueryIds> {
    const keys = [...HARVESTED_OPERATIONS.map(queryIdStorageKey), 'queryIds'];
    const stored = await chrome.storage.local.get(keys);
    const legacy = (stored.queryIds || {}) as QueryIds;
    const queryIds: QueryIds = {};
    for (const operation of HARVESTED_OPERATIONS) {
        const value = stored[queryIdStorageKey(operation)] ?? legacy[operation];
        if (isValidQueryId(value)) queryIds[operation] = value;
    }
    return queryIds;
}

export async function storeQueryId(operationName: HarvestedOperation, queryId: string): Promise<void> {
    if (!isValidQueryId(queryId)) return;
    await chrome.storage.local.set({ [queryIdStorageKey(operationName)]: queryId });
}

export async function clearQueryId(operationName: HarvestedOperation): Promise<void> {
    await chrome.storage.local.remove(queryIdStorageKey(operationName));
}

// A lowercased handle -> the IDs of the lists it belongs to.
export type ListCache = Record<string, string[]>;
// List ID -> current display name.
export type ListMeta = Record<string, string>;

export type SyncErrorCode =
    | 'auth'
    | 'contract'
    | 'graphql'
    | 'http'
    | 'network'
    | 'rate_limit'
    | 'server'
    | 'setup'
    | 'storage'
    | 'timeout'
    | 'interrupted'
    | 'unknown';

export type SyncState =
    | { status: 'idle' }
    | { status: 'running'; runId?: string; done: number; total: number; list?: string; cancelRequested?: boolean }
    | { status: 'done'; at?: number; listCount?: number; peopleCount?: number }
    | { status: 'cancelled'; at?: number }
    | { status: 'error'; at?: number; error: string; code?: SyncErrorCode };

// chrome.storage.local.get() is typed as {} - narrow it once, here.
export const getLocal = (keys: string[]) => chrome.storage.local.get(keys) as Promise<Record<string, any>>;
