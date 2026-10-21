import {
    MSG,
    getLocal,
    getStoredQueryIds,
    type SyncMode,
    type SyncState,
} from './shared';
import { getUserIdFromTwid } from './list-filter';
import { CACHE_VERSION, runSync } from './sync';
import { createAbortError, waitWithAbort } from './abortable';
import { XApiError, errorFromResponse } from './x-api';
import { createErrorState } from './sync-state';

const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;

const delay = (ms: number, signal?: AbortSignal) => waitWithAbort(ms, signal);

// The popup reads status from storage, so it stays correct even if it was closed
// while a sync was running.
const setSyncState = (syncState: SyncState) => chrome.storage.local.set({ syncState });

async function readXCookie(name: string): Promise<string | undefined> {
    try {
        const cookie = await chrome.cookies.get({ url: 'https://x.com', name });
        return cookie?.value || undefined;
    } catch (error) {
        // Safari rejects this when the user has not allowed ListLens on x.com.
        throw new XApiError(`Could not read the X ${name} cookie: ${String(error)}`, 'auth', undefined, { cause: error });
    }
}

async function getCsrfToken(): Promise<string> {
    const value = await readXCookie('ct0');
    if (!value) throw new XApiError('Not logged into X (no ct0 cookie found).', 'auth');
    return value;
}

async function getCurrentUserId(): Promise<string | undefined> {
    const value = await readXCookie('twid');
    return value ? getUserIdFromTwid(value) : undefined;
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
        throw new XApiError(`${hint} (${operationName})`, 'setup', operationName);
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

    if (!response.ok) throw await errorFromResponse(response, new URL(url).pathname.split('/').pop());
    return response.json();
}

let fullSyncRunning = false;
let cancelRequested = false;
let activeSyncController: AbortController | null = null;

function isSyncCancelled(): boolean {
    return cancelRequested || activeSyncController?.signal.aborted === true;
}

async function syncLists(mode: SyncMode = 'full') {
    if (fullSyncRunning) return;
    fullSyncRunning = true;
    cancelRequested = false;
    const syncController = new AbortController();
    activeSyncController = syncController;
    console.info(`[ListLens:Background] ${mode} sync started.`);

    try {
        await setSyncState({ status: 'running', done: 0, total: 0 });

        const csrfToken = await getCsrfToken();
        const lists = await getDynamicQueryId('ListsManagementPageTimeline');
        const members = await getDynamicQueryId('ListMembers');
        const currentUserId = await getCurrentUserId();
        if (!currentUserId) {
            throw new XApiError('Could not determine the signed-in X user ID (no twid cookie found).', 'auth');
        }
        const { ListOwnerships: ownerships } = await getStoredQueryIds();

        const result = await runSync(mode, {
            fetchJson: (url, signal) => fetchWithAuth(url, csrfToken, 0, signal),
            delay,
            currentUserId,
            queryIds: { lists, members, ownerships },
            isCancelled: isSyncCancelled,
            signal: syncController.signal,
        });
        if (result === 'cancelled') {
            console.log('[ListLens:Background] Sync cancelled by user.');
            await setSyncState({ status: 'cancelled', at: Date.now() });
        }
    } catch (error) {
        if (isSyncCancelled()) {
            console.log('[ListLens:Background] Sync cancelled by user.');
            await setSyncState({ status: 'cancelled', at: Date.now() });
        } else {
            console.error('[ListLens:Background] Sync failed', error);
            await setSyncState(createErrorState(error));
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

    if (message?.type === MSG.SYNC_STATUS) {
        // A worker that just woke up has no sync running, whatever storage says.
        sendResponse({ running: fullSyncRunning });
    }

    if (message?.type === MSG.CANCEL_SYNC) {
        void requestSyncCancellation();
        sendResponse({ status: 'cancelling' });
    }

});
