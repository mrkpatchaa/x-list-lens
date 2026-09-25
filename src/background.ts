import {
    MSG,
    getLocal,
    getStoredQueryIds,
    type ListCache,
    type ListMeta,
    type SyncState,
} from './shared';

const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// listCache stores list IDs, not names (v1 stored names). Bump to discard old shapes.
const CACHE_VERSION = 2;
const PAGE_SIZE = 100;
const MUTATION_DEBOUNCE_MS = 1000;
const INTER_LIST_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The popup reads status from storage, so it stays correct even if it was closed
// while a sync was running.
const setSyncState = (syncState: SyncState) => chrome.storage.local.set({ syncState });

async function getCsrfToken(): Promise<string> {
    const cookie = await chrome.cookies.get({ url: 'https://x.com', name: 'ct0' });
    if (!cookie?.value) throw new Error('Not logged into X');
    return cookie.value;
}

async function getDynamicQueryId(operationName: string): Promise<string> {
    const queryIds = await getStoredQueryIds();
    const queryId = queryIds[operationName as keyof typeof queryIds];
    if (!queryId) {
        throw new Error(`Please click into one of your lists on X so we can harvest the ${operationName} query ID!`);
    }
    return queryId;
}

// A single 429 used to abort the whole sync and throw away every list already
// fetched. Back off and retry transient failures instead.
async function fetchWithAuth(url: string, csrfToken: string, attempt = 0): Promise<any> {
    let response: Response;
    try {
        response = await fetch(url, {
            credentials: 'include', // the service worker's origin differs from x.com, so cookies need opting in
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
                'Authorization': `Bearer ${BEARER_TOKEN}`,
                'x-csrf-token': csrfToken,
                'x-twitter-auth-type': 'OAuth2Session',
                'x-twitter-active-user': 'yes',
            },
        });
    } catch (e) {
        if (attempt >= MAX_RETRIES) throw e;
        await delay(2000 * 2 ** attempt);
        return fetchWithAuth(url, csrfToken, attempt + 1);
    }

    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        console.warn(`[ListLens:Background] ${response.status} from X, backing off (attempt ${attempt + 1}).`);
        await delay(2000 * 2 ** attempt);
        return fetchWithAuth(url, csrfToken, attempt + 1);
    }

    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    return response.json();
}

function collectScreenNames(obj: any, into: string[]) {
    if (!obj || typeof obj !== 'object') return;
    if (typeof obj.screen_name === 'string' && obj.screen_name.length > 0) into.push(obj.screen_name);
    for (const key of Object.keys(obj)) collectScreenNames(obj[key], into);
}

// Read members off the timeline entries rather than deep-scanning the whole
// response, which also picked up the list owner and other embedded users.
function parseMembersPage(data: any): { handles: string[]; cursor: string } {
    const instructions = data?.data?.list?.members_timeline?.timeline?.instructions || [];
    const entries = instructions.find((i: any) => i.type === 'TimelineAddEntries')?.entries || [];

    const handles: string[] = [];
    let cursor = '';

    for (const entry of entries) {
        const entryId: string = entry?.entryId || '';
        if (entryId.startsWith('cursor-bottom')) {
            cursor = entry?.content?.value || '';
            continue;
        }
        const result = entry?.content?.itemContent?.user_results?.result;
        const screenName = result?.core?.screen_name ?? result?.legacy?.screen_name;
        if (typeof screenName === 'string' && screenName) handles.push(screenName);
    }

    // Fall back to the old deep scan if X changes the payload shape on us.
    if (handles.length === 0) collectScreenNames(entries.length > 0 ? entries : data, handles);

    return { handles, cursor };
}

async function fetchListMembers(
    listId: string,
    membersQueryId: string,
    csrfToken: string,
    cancelled: () => boolean = () => false,
): Promise<Set<string>> {
    const members = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = '';
    let pagesWithoutHandles = 0;

    while (true) {
        const variables = JSON.stringify({ listId, count: PAGE_SIZE, cursor: cursor || undefined });
        const url = `https://x.com/i/api/graphql/${membersQueryId}/ListMembers?variables=${encodeURIComponent(variables)}`;
        const { handles, cursor: nextCursor } = parseMembersPage(await fetchWithAuth(url, csrfToken));

        for (const handle of handles) members.add(handle.toLowerCase());

        if (handles.length === 0) {
            if (++pagesWithoutHandles >= 2) break;
        } else {
            pagesWithoutHandles = 0;
        }

        if (cancelled()) break;
        if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;

        await delay(Math.floor(Math.random() * 700) + 800);
    }

    return members;
}

// Serialize every cache read-modify-write so overlapping syncs can't clobber each other.
let cacheWrites: Promise<void> = Promise.resolve();
function updateCache(mutate: (cache: ListCache) => void): Promise<void> {
    // Swallow failures into the chain: one rejection would otherwise poison every
    // queued write that follows it.
    const next = cacheWrites.then(async () => {
        const { listCache } = await getLocal(['listCache']);
        const cache = (listCache || {}) as ListCache;
        mutate(cache);
        for (const handle of Object.keys(cache)) {
            if (cache[handle].length === 0) delete cache[handle];
        }
        await chrome.storage.local.set({ listCache: cache });
    });
    cacheWrites = next.catch((e) => { console.error('[ListLens:Background] Cache write failed', e); });
    return next;
}

// ---------------------------------------------------------
// TARGETED LIST SYNC
// Triggered when a user is added/removed natively on X.
// ---------------------------------------------------------
const inFlight = new Set<string>();

async function syncSingleList(listId: string) {
    // A second mutation landing mid-refetch must not race the first one; re-queue it.
    if (inFlight.has(listId)) {
        queueListSync(listId);
        return;
    }
    inFlight.add(listId);

    const { listMeta } = await getLocal(['listMeta']);
    const listName = (listMeta || {})[listId] || listId;
    console.log(`[ListLens:Background] Performing targeted sync for modified list: "${listName}"`);

    try {
        const csrfToken = await getCsrfToken();
        const membersQueryId = await getDynamicQueryId('ListMembers');
        const members = await fetchListMembers(listId, membersQueryId, csrfToken);

        await updateCache((cache) => {
            for (const handle of Object.keys(cache)) {
                cache[handle] = cache[handle].filter((id) => id !== listId);
            }
            for (const handle of members) {
                if (!cache[handle]) cache[handle] = [];
                if (!cache[handle].includes(listId)) cache[handle].push(listId);
            }
        });

        console.log(`[ListLens:Background] Targeted sync complete! ${members.size} members in "${listName}".`);
    } catch (e) {
        console.error(`[ListLens:Background] Targeted sync failed for ${listName}`, e);
    } finally {
        inFlight.delete(listId);
    }
}

// A user adding several people in a row shouldn't trigger a refetch per click.
const pendingSyncs = new Map<string, ReturnType<typeof setTimeout>>();
function queueListSync(listId: string) {
    clearTimeout(pendingSyncs.get(listId));
    pendingSyncs.set(listId, setTimeout(() => {
        pendingSyncs.delete(listId);
        if (!fullSyncRunning) syncSingleList(listId);
    }, MUTATION_DEBOUNCE_MS));
}

// ---------------------------------------------------------
// MAIN FULL SYNC
// ---------------------------------------------------------
function extractLists(obj: any, into: { id: string; name: string }[] = []): { id: string; name: string }[] {
    if (!obj || typeof obj !== 'object') return into;
    if (obj.id_str && obj.name && (obj.member_count !== undefined || obj.mode !== undefined)) {
        into.push({ id: obj.id_str, name: obj.name });
    }
    for (const key of Object.keys(obj)) extractLists(obj[key], into);
    return into;
}

let fullSyncRunning = false;
let cancelRequested = false;

async function syncLists() {
    if (fullSyncRunning) return;
    fullSyncRunning = true;
    cancelRequested = false;

    try {
        await setSyncState({ status: 'running', done: 0, total: 0 });

        const csrfToken = await getCsrfToken();
        const listsQueryId = await getDynamicQueryId('ListsManagementPageTimeline');
        const membersQueryId = await getDynamicQueryId('ListMembers');

        const listsUrl = `https://x.com/i/api/graphql/${listsQueryId}/ListsManagementPageTimeline?variables=${encodeURIComponent('{"count":100}')}`;
        const lists = extractLists(await fetchWithAuth(listsUrl, csrfToken));
        if (lists.length === 0) throw new Error('Could not parse list structures from JSON.');

        const listMeta: ListMeta = {};
        for (const list of lists) listMeta[list.id] = list.name;
        await chrome.storage.local.set({ listMeta });

        const localCache: ListCache = {};
        let done = 0;

        for (const list of lists) {
            if (cancelRequested) break;
            await setSyncState({ status: 'running', done, total: lists.length, list: list.name });

            const members = await fetchListMembers(list.id, membersQueryId, csrfToken, () => cancelRequested);
            if (cancelRequested) break;

            for (const handle of members) {
                if (!localCache[handle]) localCache[handle] = [];
                localCache[handle].push(list.id);
            }
            done++;
            await delay(INTER_LIST_DELAY_MS);
        }

        if (cancelRequested) {
            // Leave the previous cache untouched rather than committing a partial one.
            console.log('[ListLens:Background] Sync cancelled by user.');
            await setSyncState({ status: 'idle' });
            return;
        }

        await chrome.storage.local.set({ listCache: localCache, lastSync: Date.now(), cacheVersion: CACHE_VERSION });
        await setSyncState({ status: 'done' });
    } catch (error) {
        console.error('[ListLens:Background] Full sync failed', error);
        await setSyncState({ status: 'error', error: String(error) });
    } finally {
        fullSyncRunning = false;
        cancelRequested = false;
    }
}

chrome.runtime.onInstalled.addListener(async () => {
    const { cacheVersion } = await getLocal(['cacheVersion']);
    if (cacheVersion !== CACHE_VERSION) {
        await chrome.storage.local.remove(['listCache', 'lastSync']);
        await chrome.storage.local.set({ cacheVersion: CACHE_VERSION });
    }
});

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    if (message?.type === MSG.START_SYNC) {
        syncLists();
        sendResponse({ status: 'started' });
    }

    if (message?.type === MSG.CANCEL_SYNC) {
        cancelRequested = true;
        sendResponse({ status: 'cancelling' });
    }

    if (message?.type === MSG.LIST_MUTATION && message.payload?.listId) {
        queueListSync(message.payload.listId);
    }
});
