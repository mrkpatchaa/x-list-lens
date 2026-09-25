import {
    MSG,
    getLocal,
    getStoredQueryIds,
    isListMutationMessage,
    type ListCache,
    type ListMeta,
    type SyncState,
    type UserHandleIndex,
} from './shared';
import { applyMembershipDelta } from './cache-delta';
import { getUserIdFromTwid } from './list-filter';
import {
    buildListOwnershipsVariables,
    parseListManagementPage,
    parseOwnedListsPage,
    type OwnedListSummary,
} from './list-ownership';
import { createAbortError, waitWithAbort } from './abortable';

const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// listCache stores list IDs, not names (v1 stored names). Bump to discard old shapes.
const CACHE_VERSION = 2;
const PAGE_SIZE = 100;
const INTER_LIST_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;

const delay = (ms: number, signal?: AbortSignal) => waitWithAbort(ms, signal);

// The popup reads status from storage, so it stays correct even if it was closed
// while a sync was running.
const setSyncState = (syncState: SyncState) => chrome.storage.local.set({ syncState });

async function getCsrfToken(): Promise<string> {
    const cookie = await chrome.cookies.get({ url: 'https://x.com', name: 'ct0' });
    if (!cookie?.value) throw new Error('Not logged into X');
    return cookie.value;
}

async function getCurrentUserId(): Promise<string | undefined> {
    const cookie = await chrome.cookies.get({ url: 'https://x.com', name: 'twid' });
    return cookie?.value ? getUserIdFromTwid(cookie.value) : undefined;
}

async function getDynamicQueryId(operationName: string): Promise<string> {
    const queryIds = await getStoredQueryIds();
    const queryId = queryIds[operationName as keyof typeof queryIds];
    if (!queryId) {
        const hint = operationName === 'ListsManagementPageTimeline'
            ? 'Open your Lists page on X so ListLens can harvest the list request.'
            : operationName === 'ListOwnerships'
                ? 'Open your own profile’s Lists tab on X so we can harvest the ownership request.'
                : 'Open one of your lists on X so we can harvest the member request.';
        throw new Error(`${hint} (${operationName})`);
    }
    return queryId;
}

// A single 429 used to abort the whole sync and throw away every list already
// fetched. Back off and retry transient failures instead.
async function fetchWithAuth(
    url: string,
    csrfToken: string,
    attempt = 0,
    signal?: AbortSignal,
): Promise<any> {
    if (signal?.aborted) throw createAbortError();

    const requestController = new AbortController();
    const onExternalAbort = () => requestController.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timeoutId = setTimeout(() => requestController.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(url, {
            credentials: 'include', // the service worker's origin differs from x.com, so cookies need opting in
            signal: requestController.signal,
            headers: {
                'Authorization': `Bearer ${BEARER_TOKEN}`,
                'x-csrf-token': csrfToken,
                'x-twitter-auth-type': 'OAuth2Session',
                'x-twitter-active-user': 'yes',
            },
        });
    } catch (e) {
        if (signal?.aborted) throw createAbortError();
        if (attempt >= MAX_RETRIES) throw e;
        await delay(2000 * 2 ** attempt, signal);
        return fetchWithAuth(url, csrfToken, attempt + 1, signal);
    } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onExternalAbort);
    }

    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        console.warn(`[ListLens:Background] ${response.status} from X, backing off (attempt ${attempt + 1}).`);
        await delay(2000 * 2 ** attempt, signal);
        return fetchWithAuth(url, csrfToken, attempt + 1, signal);
    }

    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    return response.json();
}

function collectScreenNames(obj: any, into: string[]) {
    if (!obj || typeof obj !== 'object') return;
    if (typeof obj.screen_name === 'string' && obj.screen_name.length > 0) into.push(obj.screen_name);
    for (const key of Object.keys(obj)) collectScreenNames(obj[key], into);
}

type MemberIdentity = { userId: string; handle: string };
const USER_ID_RE = /^\d{1,32}$/;

// Read members off the timeline entries rather than deep-scanning the whole
// response, which also picked up the list owner and other embedded users.
function parseMembersPage(data: any): { handles: string[]; cursor: string; members: MemberIdentity[] } {
    const instructions = data?.data?.list?.members_timeline?.timeline?.instructions || [];
    const entries = instructions.find((i: any) => i.type === 'TimelineAddEntries')?.entries || [];

    const handles: string[] = [];
    const members: MemberIdentity[] = [];
    let cursor = '';

    for (const entry of entries) {
        const entryId: string = entry?.entryId || '';
        if (entryId.startsWith('cursor-bottom')) {
            cursor = entry?.content?.value || '';
            continue;
        }
        const result = entry?.content?.itemContent?.user_results?.result;
        const screenName = result?.core?.screen_name ?? result?.legacy?.screen_name;
        if (typeof screenName === 'string' && screenName) {
            handles.push(screenName);
            const userId = result?.rest_id ?? result?.id_str ?? result?.legacy?.id_str;
            if (typeof userId === 'string' && USER_ID_RE.test(userId)) {
                members.push({ userId, handle: screenName.toLowerCase() });
            }
        }
    }

    // Fall back to the old deep scan if X changes the payload shape on us.
    if (handles.length === 0) collectScreenNames(entries.length > 0 ? entries : data, handles);

    return { handles, cursor, members };
}

async function fetchListMembers(
    listId: string,
    membersQueryId: string,
    csrfToken: string,
    cancelled: () => boolean = () => false,
    onMember: (member: MemberIdentity) => void = () => undefined,
    signal?: AbortSignal,
): Promise<Set<string>> {
    const members = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = '';
    let pagesWithoutHandles = 0;

    while (true) {
        const variables = JSON.stringify({ listId, count: PAGE_SIZE, cursor: cursor || undefined });
        const url = `https://x.com/i/api/graphql/${membersQueryId}/ListMembers?variables=${encodeURIComponent(variables)}`;
        if (cancelled() || signal?.aborted) throw createAbortError();
        const page = parseMembersPage(await fetchWithAuth(url, csrfToken, 0, signal));
        const handles = page.handles;
        const nextCursor = page.cursor;

        for (const handle of handles) members.add(handle.toLowerCase());
        for (const member of page.members) onMember(member);

        if (handles.length === 0) {
            if (++pagesWithoutHandles >= 2) break;
        } else {
            pagesWithoutHandles = 0;
        }

        if (cancelled()) break;
        if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;

        await delay(Math.floor(Math.random() * 700) + 800, signal);
    }

    return members;
}

// ---------------------------------------------------------
// TARGETED LIST MUTATIONS
// Apply the membership delta locally; do not re-walk the whole list.
// ---------------------------------------------------------
async function applyListMutation(payload: {
    listId: string;
    userId: string;
    action: 'add' | 'remove';
    handle?: string;
}): Promise<void> {
    try {
        const { listCache, userHandles } = await getLocal(['listCache', 'userHandles']);
        const index = (userHandles || {}) as UserHandleIndex;
        const handle = payload.handle || index[payload.userId];

        if (!handle) {
            await chrome.storage.local.set({ needsFullSync: true });
            console.warn(`[ListLens:Background] No cached handle for user ${payload.userId}; full sync required.`);
            return;
        }

        const nextCache = applyMembershipDelta(
            (listCache || {}) as ListCache,
            payload.listId,
            handle,
            payload.action,
        );
        const nextIndex = { ...index, [payload.userId]: handle.toLowerCase() };
        await chrome.storage.local.set({ listCache: nextCache, userHandles: nextIndex });
        console.info(`[ListLens:Background] Applied ${payload.action} for @${handle} without refetching the list.`);
    } catch (error) {
        console.error('[ListLens:Background] Could not apply list mutation', error);
    }
}

// ---------------------------------------------------------
// MAIN FULL SYNC
// ---------------------------------------------------------
async function fetchOwnedLists(
    queryId: string,
    currentUserId: string,
    csrfToken: string,
    operation: 'ListsManagementPageTimeline' | 'ListOwnerships',
    cancelled: () => boolean = () => false,
    signal?: AbortSignal,
): Promise<OwnedListSummary[]> {
    const lists = new Map<string, OwnedListSummary>();
    const seenCursors = new Set<string>();
    let cursor = '';

    while (true) {
        if (cancelled() || signal?.aborted) throw createAbortError();
        const variables = operation === 'ListOwnerships'
            ? buildListOwnershipsVariables(currentUserId, PAGE_SIZE, cursor)
            : JSON.stringify({ count: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        const url = `https://x.com/i/api/graphql/${queryId}/${operation}?variables=${encodeURIComponent(variables)}`;
        const payload = await fetchWithAuth(url, csrfToken, 0, signal);
        const page = operation === 'ListOwnerships'
            ? parseOwnedListsPage(payload, currentUserId)
            : parseListManagementPage(payload, currentUserId);

        for (const list of page.lists) lists.set(list.id, list);

        if (cancelled()) break;
        if (!page.cursor || page.cursor === cursor || seenCursors.has(page.cursor)) break;
        seenCursors.add(page.cursor);
        cursor = page.cursor;

        await delay(Math.floor(Math.random() * 700) + 800, signal);
    }

    return [...lists.values()];
}

let fullSyncRunning = false;
let cancelRequested = false;
let activeSyncController: AbortController | null = null;

function isSyncCancelled(): boolean {
    return cancelRequested || activeSyncController?.signal.aborted === true;
}

async function syncLists() {
    if (fullSyncRunning) return;
    fullSyncRunning = true;
    cancelRequested = false;
    const syncController = new AbortController();
    activeSyncController = syncController;

    try {
        await setSyncState({ status: 'running', done: 0, total: 0 });

        const csrfToken = await getCsrfToken();
        const listsQueryId = await getDynamicQueryId('ListsManagementPageTimeline');
        const membersQueryId = await getDynamicQueryId('ListMembers');
        const currentUserId = await getCurrentUserId();
        if (!currentUserId) {
            throw new Error('Could not determine the signed-in X user ID. Sign in to X and try again.');
        }

        let lists: OwnedListSummary[];
        try {
            lists = await fetchOwnedLists(
                listsQueryId,
                currentUserId,
                csrfToken,
                'ListsManagementPageTimeline',
                isSyncCancelled,
                syncController.signal,
            );
        } catch (managementError) {
            if (isSyncCancelled()) throw managementError;
            const queryIds = await getStoredQueryIds();
            const ownershipsQueryId = queryIds.ListOwnerships;
            if (!ownershipsQueryId) throw managementError;

            console.warn('[ListLens:Background] Lists management response failed; trying ListOwnerships.', managementError);
            lists = await fetchOwnedLists(
                ownershipsQueryId,
                currentUserId,
                csrfToken,
                'ListOwnerships',
                isSyncCancelled,
                syncController.signal,
            );
        }

        const listMeta: ListMeta = {};
        for (const list of lists) listMeta[list.id] = list.name;

        const localCache: ListCache = {};
        const { userHandles } = await getLocal(['userHandles']);
        const nextUserHandles: UserHandleIndex = { ...(userHandles || {}) };
        let done = 0;

        for (const list of lists) {
            if (isSyncCancelled()) break;
            await setSyncState({ status: 'running', done, total: lists.length, list: list.name });

            const members = await fetchListMembers(
                list.id,
                membersQueryId,
                csrfToken,
                isSyncCancelled,
                (member) => { nextUserHandles[member.userId] = member.handle; },
                syncController.signal,
            );
            if (isSyncCancelled()) break;

            for (const handle of members) {
                if (!localCache[handle]) localCache[handle] = [];
                localCache[handle].push(list.id);
            }
            done++;
            await delay(INTER_LIST_DELAY_MS, syncController.signal);
        }

        if (isSyncCancelled()) {
            // Leave the previous cache untouched rather than committing a partial one.
            console.log('[ListLens:Background] Sync cancelled by user.');
            await setSyncState({ status: 'cancelled', at: Date.now() });
            return;
        }

        await chrome.storage.local.set({
            listCache: localCache,
            listMeta,
            userHandles: nextUserHandles,
            needsFullSync: false,
            lastSync: Date.now(),
            cacheVersion: CACHE_VERSION,
        });
        await setSyncState({
            status: 'done',
            at: Date.now(),
            listCount: lists.length,
            peopleCount: Object.keys(localCache).length,
        });
    } catch (error) {
        if (isSyncCancelled()) {
            console.log('[ListLens:Background] Sync cancelled by user.');
            await setSyncState({ status: 'cancelled', at: Date.now() });
        } else {
            console.error('[ListLens:Background] Full sync failed', error);
            await setSyncState({ status: 'error', error: String(error) });
        }
    } finally {
        fullSyncRunning = false;
        cancelRequested = false;
        activeSyncController = null;
    }
}

async function requestSyncCancellation(): Promise<void> {
    cancelRequested = true;
    activeSyncController?.abort();

    const { syncState } = await getLocal(['syncState']);
    if (syncState?.status !== 'running') return;

    if (!activeSyncController) {
        // The worker may have restarted while the popup still shows a running
        // sync. Mark that orphaned state stopped instead of leaving it stuck.
        await setSyncState({ status: 'cancelled', at: Date.now() });
        return;
    }

    await setSyncState({ ...syncState, cancelRequested: true });
}

chrome.runtime.onInstalled.addListener(async () => {
    const { cacheVersion } = await getLocal(['cacheVersion']);
    if (cacheVersion !== CACHE_VERSION) {
        await chrome.storage.local.remove(['listCache', 'userHandles', 'needsFullSync', 'lastSync']);
        await chrome.storage.local.set({ cacheVersion: CACHE_VERSION });
    }
});

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    if (message?.type === MSG.START_SYNC) {
        syncLists();
        sendResponse({ status: 'started' });
    }

    if (message?.type === MSG.CANCEL_SYNC) {
        void requestSyncCancellation();
        sendResponse({ status: 'cancelling' });
    }

    if (isListMutationMessage(message)) {
        void applyListMutation(message.payload);
    }
});
