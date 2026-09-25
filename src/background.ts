import {
    HARVESTED_OPERATIONS,
    MSG,
    clearQueryId,
    getLocal,
    getStoredQueryIds,
    isListMutationMessage,
    isValidListId,
    isValidQueryId,
    storeQueryId,
    type ListCache,
    type ListMeta,
    type QueryIds,
    type RequiredOperation,
    type SyncState,
} from './shared'
import { createDoneState, createErrorState, isSyncCancelled } from './sync-state'
import {
    XApiError,
    assertSuccessfulGraphQLPayload,
    parseListsPage,
    parseMembersPage,
    replaceListMembership,
} from './x-api'

// This public web token is shared by X's own client. It is not a user secret.
const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const CACHE_VERSION = 2;
const PAGE_SIZE = 100;
const MUTATION_DEBOUNCE_MS = 1000;
const INTER_LIST_DELAY_MS = 1000;
const PAGE_DELAY_MIN_MS = 800;
const PAGE_DELAY_JITTER_MS = 700;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;
const DIRTY_LIST_PREFIX = 'dirtyList:';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const touchServiceWorker = () => chrome.storage.local.set({ syncHeartbeat: Date.now() });
const setSyncState = (syncState: SyncState) => chrome.storage.local.set({ syncState });

async function getCsrfToken(): Promise<string> {
    try {
        const cookie = await chrome.cookies.get({ url: 'https://x.com', name: 'ct0' });
        if (!cookie?.value) throw new Error('Missing ct0 cookie');
        return cookie.value;
    } catch (error) {
        throw new XApiError('Not logged into X.', 'auth', undefined, { cause: error });
    }
}

async function getDynamicQueryId(operationName: RequiredOperation): Promise<string> {
    const queryIds = await getStoredQueryIds();
    const queryId = queryIds[operationName];
    if (!queryId) {
        throw new XApiError(`Missing the ${operationName} query ID.`, 'setup', operationName);
    }
    return queryId;
}

function retryDelay(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) return Math.min(8_000, Math.max(500, seconds * 1000));
    }

    const reset = Number(response.headers.get('x-rate-limit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
        return Math.min(8_000, Math.max(500, reset * 1000 - Date.now()));
    }

    return Math.min(8_000, 1_000 * 2 ** attempt + Math.floor(Math.random() * 400));
}

async function fetchWithAuth(url: string, csrfToken: string, operation: RequiredOperation): Promise<unknown> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        let response: Response;
        try {
            response = await fetch(url, {
                credentials: 'include',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                headers: {
                    'Authorization': `Bearer ${BEARER_TOKEN}`,
                    'x-csrf-token': csrfToken,
                    'x-twitter-auth-type': 'OAuth2Session',
                    'x-twitter-active-user': 'yes',
                },
            });
        } catch (error) {
            const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
            if (attempt < MAX_RETRIES) {
                await delay(retryDelay(new Response(), attempt));
                continue;
            }
            throw new XApiError(
                timedOut ? 'The request to X timed out.' : 'Could not reach X.',
                timedOut ? 'timeout' : 'network',
                operation,
                { cause: error },
            );
        }

        if (response.status === 400 || response.status === 404) {
            await clearQueryId(operation);
            throw new XApiError(`X no longer recognizes the ${operation} request.`, 'setup', operation);
        }

        if (response.status === 401 || response.status === 403) {
            throw new XApiError('X rejected the signed-in session.', 'auth', operation);
        }

        if (response.status === 429 || response.status >= 500) {
            if (attempt < MAX_RETRIES) {
                await delay(retryDelay(response, attempt));
                continue;
            }
            throw new XApiError(
                response.status === 429 ? 'X is rate-limiting requests.' : 'X is having trouble right now.',
                response.status === 429 ? 'rate_limit' : 'server',
                operation,
            );
        }

        if (!response.ok) {
            throw new XApiError(`X returned HTTP ${response.status}.`, 'http', operation);
        }

        let payload: unknown;
        try {
            payload = await response.json();
        } catch (error) {
            throw new XApiError('X returned invalid JSON.', 'contract', operation, { cause: error });
        }
        return assertSuccessfulGraphQLPayload(payload, operation);
    }

    throw new XApiError('The request could not be completed.', 'unknown', operation);
}

type PageOptions = {
    onPage?: () => Promise<void>;
    isCancelled?: () => Promise<boolean>;
};

async function fetchListMembers(
    listId: string,
    membersQueryId: string,
    csrfToken: string,
    options: PageOptions = {},
): Promise<Set<string>> {
    const members = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = '';

    while (true) {
        const variables = JSON.stringify({ listId, count: PAGE_SIZE, cursor: cursor || undefined });
        const url = `https://x.com/i/api/graphql/${membersQueryId}/ListMembers?variables=${encodeURIComponent(variables)}`;
        const page = parseMembersPage(await fetchWithAuth(url, csrfToken, 'ListMembers'));
        for (const handle of page.handles) members.add(handle.toLowerCase());

        await options.onPage?.();
        if (await options.isCancelled?.()) break;
        if (!page.cursor || page.cursor === cursor || seenCursors.has(page.cursor)) break;

        seenCursors.add(page.cursor);
        cursor = page.cursor;
        await delay(Math.floor(Math.random() * PAGE_DELAY_JITTER_MS) + PAGE_DELAY_MIN_MS);
    }

    return members;
}

async function fetchAllLists(
    listsQueryId: string,
    csrfToken: string,
    onPage?: () => Promise<void>,
): Promise<Array<{ id: string; name: string }>> {
    const lists = new Map<string, { id: string; name: string }>();
    const seenCursors = new Set<string>();
    let cursor = '';

    while (true) {
        const variables = JSON.stringify({ count: PAGE_SIZE, cursor: cursor || undefined });
        const url = `https://x.com/i/api/graphql/${listsQueryId}/ListsManagementPageTimeline?variables=${encodeURIComponent(variables)}`;
        const page = parseListsPage(await fetchWithAuth(url, csrfToken, 'ListsManagementPageTimeline'));
        for (const list of page.lists) lists.set(list.id, list);

        await onPage?.();
        if (!page.cursor || page.cursor === cursor || seenCursors.has(page.cursor)) break;

        seenCursors.add(page.cursor);
        cursor = page.cursor;
        await delay(500);
    }

    return [...lists.values()];
}

let cacheWrites: Promise<void> = Promise.resolve();
function updateListMembership(listId: string, members: ReadonlySet<string>): Promise<void> {
    const nextWrite = cacheWrites.then(async () => {
        const { listCache } = await getLocal(['listCache']);
        const nextCache = replaceListMembership((listCache || {}) as ListCache, listId, members);
        try {
            await chrome.storage.local.set({ listCache: nextCache });
        } catch (error) {
            throw new XApiError('The local list cache could not be saved.', 'storage', 'ListMembers', { cause: error });
        }
    });

    cacheWrites = nextWrite.catch((error) => {
        console.error('[ListLens:Background] Cache write failed', error);
    });
    return nextWrite;
}

const inFlightLists = new Set<string>();

async function syncSingleList(listId: string): Promise<boolean> {
    if (inFlightLists.has(listId)) return false;
    inFlightLists.add(listId);

    const { listMeta } = await getLocal(['listMeta']);
    const listName = (listMeta || {})[listId] || listId;
    console.info(`[ListLens:Background] Refreshing changed list: "${listName}"`);

    try {
        const csrfToken = await getCsrfToken();
        const membersQueryId = await getDynamicQueryId('ListMembers');
        const members = await fetchListMembers(listId, membersQueryId, csrfToken, { onPage: touchServiceWorker });
        await updateListMembership(listId, members);
        console.info(`[ListLens:Background] Refreshed "${listName}" with ${members.size} members.`);
        return true;
    } catch (error) {
        console.error(`[ListLens:Background] Could not refresh "${listName}"`, error);
        return false;
    } finally {
        inFlightLists.delete(listId);
    }
}

let dirtySyncTimer: ReturnType<typeof setTimeout> | undefined;
let dirtyProcessorRunning = false;
let fullSyncRunning = false;

function dirtyListKey(listId: string): string {
    return `${DIRTY_LIST_PREFIX}${listId}`;
}

function scheduleDirtySync(delayMs = MUTATION_DEBOUNCE_MS): void {
    if (fullSyncRunning || dirtySyncTimer) return;
    dirtySyncTimer = setTimeout(() => {
        dirtySyncTimer = undefined;
        void processDirtySyncs();
    }, delayMs);
}

function queueListSync(listId: string): void {
    if (!isValidListId(listId)) return;
    const queuedAt = Date.now();
    void chrome.storage.local
        .set({ [dirtyListKey(listId)]: queuedAt })
        .then(() => scheduleDirtySync())
        .catch((error) => console.error('[ListLens:Background] Could not queue changed list', error));
}

async function processDirtySyncs(): Promise<void> {
    if (dirtyProcessorRunning || fullSyncRunning) return;
    dirtyProcessorRunning = true;

    try {
        const stored = await chrome.storage.local.get(null);
        const dirtyLists = Object.entries(stored)
            .filter(([key, queuedAt]) => key.startsWith(DIRTY_LIST_PREFIX) && typeof queuedAt === 'number')
            .sort(([, a], [, b]) => Number(a) - Number(b));

        for (const [key, queuedAt] of dirtyLists) {
            if (fullSyncRunning) break;
            const listId = key.slice(DIRTY_LIST_PREFIX.length);
            if (!isValidListId(listId)) {
                await chrome.storage.local.remove(key);
                continue;
            }

            const refreshed = await syncSingleList(listId);
            if (!refreshed) continue;

            const latest = await chrome.storage.local.get(key);
            if (latest[key] === queuedAt) await chrome.storage.local.remove(key);
        }
    } catch (error) {
        console.error('[ListLens:Background] Could not process changed lists', error);
    } finally {
        dirtyProcessorRunning = false;
    }
}

async function isCurrentRunCancelled(runId: string): Promise<boolean> {
    const { syncState } = await getLocal(['syncState']);
    return isSyncCancelled(syncState as SyncState | undefined, runId);
}

async function commitFullSync(
    listCache: ListCache,
    listMeta: ListMeta,
    syncState: SyncState,
): Promise<void> {
    try {
        await chrome.storage.local.set({
            listCache,
            listMeta,
            lastSync: Date.now(),
            cacheVersion: CACHE_VERSION,
            syncState,
        });
    } catch (error) {
        throw new XApiError('The local list cache could not be saved.', 'storage', undefined, { cause: error });
    }
}

async function syncLists(): Promise<void> {
    if (fullSyncRunning) return;
    fullSyncRunning = true;
    const runId = crypto.randomUUID();

    try {
        await setSyncState({ status: 'running', runId, done: 0, total: 0 });
        const csrfToken = await getCsrfToken();
        const listsQueryId = await getDynamicQueryId('ListsManagementPageTimeline');
        const membersQueryId = await getDynamicQueryId('ListMembers');
        const lists = await fetchAllLists(listsQueryId, csrfToken, touchServiceWorker);

        const listMeta: ListMeta = {};
        for (const list of lists) listMeta[list.id] = list.name;

        const localCache: ListCache = {};
        let done = 0;
        for (const list of lists) {
            if (await isCurrentRunCancelled(runId)) break;
            await setSyncState({ status: 'running', runId, done, total: lists.length, list: list.name });

            const members = await fetchListMembers(list.id, membersQueryId, csrfToken, {
                onPage: touchServiceWorker,
                isCancelled: () => isCurrentRunCancelled(runId),
            });
            if (await isCurrentRunCancelled(runId)) break;

            for (const handle of members) {
                const listIds = localCache[handle] || [];
                if (!listIds.includes(list.id)) listIds.push(list.id);
                localCache[handle] = listIds;
            }
            done++;
            if (done < lists.length) await delay(INTER_LIST_DELAY_MS);
        }

        if (await isCurrentRunCancelled(runId)) {
            await setSyncState({ status: 'cancelled', at: Date.now() });
            return;
        }

        await commitFullSync(
            localCache,
            listMeta,
            createDoneState({ lists: lists.length, people: Object.keys(localCache).length }),
        );
    } catch (error) {
        await setSyncState(createErrorState(error));
    } finally {
        fullSyncRunning = false;
        scheduleDirtySync(0);
    }
}

async function migrateQueryIds(queryIds: QueryIds | undefined): Promise<void> {
    if (!queryIds || typeof queryIds !== 'object') return;
    const writes: Promise<void>[] = [];
    for (const operation of HARVESTED_OPERATIONS) {
        const queryId = queryIds[operation];
        if (isValidQueryId(queryId)) writes.push(storeQueryId(operation, queryId));
    }
    await Promise.all(writes);
    await chrome.storage.local.remove('queryIds');
}

const recoveryPromise = (async () => {
    const { syncState } = await getLocal(['syncState']);
    if ((syncState as SyncState | undefined)?.status === 'running') {
        await setSyncState(createErrorState(new XApiError(
            'The sync was interrupted when the background service restarted. Your previous cache is still available.',
            'interrupted',
        )));
    }
})();

void recoveryPromise.then(() => scheduleDirtySync(0)).catch(console.error);

chrome.runtime.onInstalled.addListener(async () => {
    const { cacheVersion, queryIds } = await getLocal(['cacheVersion', 'queryIds']);
    await migrateQueryIds(queryIds as QueryIds | undefined);
    if (cacheVersion !== CACHE_VERSION) {
        await chrome.storage.local.remove(['listCache', 'listMeta', 'lastSync']);
        await chrome.storage.local.set({ cacheVersion: CACHE_VERSION });
    }
});

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return;

    const typedMessage = message as { type?: unknown };
    if (typedMessage.type === MSG.START_SYNC) {
        void recoveryPromise.then(syncLists).catch(console.error);
    }

    if (typedMessage.type === MSG.CANCEL_SYNC) {
        void (async () => {
            await recoveryPromise;
            const { syncState } = await getLocal(['syncState']);
            const current = syncState as SyncState | undefined;
            if (current?.status === 'running') {
                await setSyncState({ ...current, cancelRequested: true });
            }
        })().catch(console.error);
    }

    if (isListMutationMessage(message)) {
        queueListSync(message.payload.listId);
    }
});
