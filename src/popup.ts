import {
    MSG,
    getLocal,
    getMissingOperations,
    getStoredQueryIds,
    type ListCache,
    type ListMeta,
    type QueryIds,
    type SyncState,
} from './shared';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const syncBtn = el<HTMLButtonElement>('syncBtn');
const cancelBtn = el<HTMLButtonElement>('cancelBtn');
const openListsBtn = el<HTMLButtonElement>('openListsBtn');
const reconnectBtn = el<HTMLButtonElement>('reconnectBtn');
const setupNotice = el<HTMLDivElement>('setupNotice');
const setupEyebrow = el<HTMLParagraphElement>('setupEyebrow');
const setupTitle = el<HTMLHeadingElement>('setupTitle');
const setupCopy = el<HTMLParagraphElement>('setupCopy');
const setupListsStep = el<HTMLSpanElement>('setupListsStep');
const setupListStep = el<HTMLSpanElement>('setupListStep');
const statusBadge = el<HTMLSpanElement>('statusBadge');
const peopleCount = el<HTMLSpanElement>('peopleCount');
const peopleWord = el<HTMLSpanElement>('peopleWord');
const listCount = el<HTMLParagraphElement>('listCount');
const lastSyncEl = el<HTMLParagraphElement>('lastSync');
const progressWrap = el<HTMLDivElement>('progressWrap');
const progressBar = el<HTMLDivElement>('progressBar');
const progressLabel = el<HTMLParagraphElement>('progressLabel');
const hintMsg = el<HTMLParagraphElement>('hintMsg');
const errorMsg = el<HTMLParagraphElement>('errorMsg');

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const numberFormat = new Intl.NumberFormat();

const BADGE_BASE = 'px-2 py-1 text-[11px] font-semibold rounded-full ';
const statusClasses = {
    checking: BADGE_BASE + 'bg-slate-800 text-slate-300',
    ready: BADGE_BASE + 'bg-slate-800 text-slate-300',
    running: BADGE_BASE + 'bg-blue-950 text-blue-300',
    done: BADGE_BASE + 'bg-emerald-950 text-emerald-300',
    cancelled: BADGE_BASE + 'bg-amber-950 text-amber-300',
    error: BADGE_BASE + 'bg-red-950 text-red-300',
};

function relativeTime(timestamp: number) {
    const elapsed = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
    return `${numberFormat.format(count)} ${count === 1 ? singular : pluralForm}`;
}

function friendlyError(state: Extract<SyncState, { status: 'error' }>) {
    switch (state.code) {
        case 'auth':
            return 'You are signed out of X. Sign in, then try again.';
        case 'setup':
        case 'contract':
        case 'graphql':
            return 'X changed the Lists request. Reconnect, then try again.';
        case 'rate_limit':
            return 'X is rate-limiting requests. Wait a few minutes and try again.';
        case 'server':
            return 'X is having trouble right now. Try again shortly.';
        case 'network':
            return 'Could not reach X. Check your connection and try again.';
        case 'timeout':
            return 'The request to X timed out. Check your connection and try again.';
        case 'storage':
            return 'The local cache could not be saved. Your previous cache is still available.';
        case 'interrupted':
            return 'The background service restarted during that sync. Your previous cache is still available.';
        case 'http':
            return 'X rejected that request. Reconnect and try again.';
        default:
            return 'Something went wrong. Your previous cache is still available.';
    }
}

function show(node: HTMLElement, visible: boolean, display = 'block') {
    node.classList.toggle('hidden', !visible);
    node.style.display = visible ? display : 'none';
}

function setStatus(label: string, kind: keyof typeof statusClasses) {
    statusBadge.textContent = label;
    statusBadge.className = statusClasses[kind];
}

function renderSetup(queryIds: QueryIds) {
    const missing = getMissingOperations(queryIds);
    const needsListMembers = missing.includes('ListMembers');
    const needsLists = missing.includes('ListsManagementPageTimeline');

    setupEyebrow.textContent = missing.length === 2 ? 'One-time setup' : 'Almost there';
    setupTitle.textContent = needsListMembers ? 'Open one of your lists' : 'Connect to your Lists';
    setupCopy.textContent = needsListMembers
        ? 'Open any list from your Lists page so ListLens can learn the member request.'
        : 'Open your Lists on X once so ListLens can learn the current request format.';
    openListsBtn.textContent = 'Open Lists on X';

    setupListsStep.className = needsLists
        ? 'setup-step setup-step-pending'
        : 'setup-step setup-step-complete';
    setupListStep.className = needsListMembers
        ? 'setup-step setup-step-pending'
        : 'setup-step setup-step-complete';
}

function render(
    state: SyncState | undefined,
    cache: ListCache,
    meta: ListMeta,
    queryIds: QueryIds,
    lastSync?: number,
    needsFullSync = false,
) {
    const people = Object.keys(cache).length;
    const lists = Object.keys(meta).length;
    const running = state?.status === 'running';
    const error = state?.status === 'error' ? state : undefined;
    const done = state?.status === 'done' ? state : undefined;
    const cancelled = state?.status === 'cancelled' ? state : undefined;
    const ready = getMissingOperations(queryIds).length === 0;

    peopleCount.textContent = numberFormat.format(people);
    peopleWord.textContent = people === 1 ? 'person' : 'people';
    listCount.textContent = lists ? `Across ${plural(lists, 'list')}` : 'No lists synced yet';
    lastSyncEl.textContent = lastSync ? `Last synced ${relativeTime(lastSync)}` : 'Never synced';

    renderSetup(queryIds);
    show(setupNotice, !ready && !running, 'flex');
    show(progressWrap, running, 'flex');
    show(cancelBtn, running, 'block');
    reconnectBtn.disabled = running;

    syncBtn.disabled = running || !ready;
    syncBtn.setAttribute('aria-busy', String(running));
    cancelBtn.disabled = state?.status === 'running' && state.cancelRequested === true;

    if (running && state.status === 'running') {
        const { done: completed, total, list, cancelRequested } = state;
        const percent = total ? Math.round((completed / total) * 100) : 5;
        progressBar.style.width = `${percent}%`;
        progressBar.setAttribute('aria-valuenow', String(percent));
        progressLabel.textContent = total
            ? `${completed} of ${total} lists${list ? ` — ${list}` : ''}`
            : 'Reading your Lists…';
        syncBtn.textContent = 'Syncing…';
        setStatus(cancelRequested ? 'Stopping' : 'Syncing', 'running');
        show(errorMsg, false);
        show(hintMsg, false);
        return;
    }

    if (error) {
        syncBtn.textContent = 'Try again';
        setStatus('Needs attention', 'error');
        errorMsg.textContent = friendlyError(error);
        show(errorMsg, true);
    } else if (cancelled) {
        syncBtn.textContent = 'Sync again';
        setStatus('Stopped', 'cancelled');
        show(errorMsg, false);
    } else if (done) {
        syncBtn.textContent = 'Re-sync lists';
        setStatus('Synced', 'done');
        show(errorMsg, false);
    } else {
        syncBtn.textContent = lastSync ? 'Re-sync lists' : 'Sync lists';
        setStatus(ready ? 'Ready' : 'Checking', ready ? 'ready' : 'checking');
        show(errorMsg, false);
    }

    const stale = lastSync !== undefined && Date.now() - lastSync > STALE_AFTER_MS;
    if (needsFullSync) {
        hintMsg.textContent = 'A list change could not be matched to a cached profile. Run a full sync when convenient.';
        show(hintMsg, true);
    } else if (cancelled) {
        hintMsg.textContent = 'Sync stopped. Your previous badges are still available.';
        show(hintMsg, true);
    } else if (done && done.listCount === 0) {
        hintMsg.textContent = 'No lists found. Create a list on X, then sync again.';
        show(hintMsg, true);
    } else if (stale && !error) {
        hintMsg.textContent = 'Your cache is over a week old — re-sync to pick up changes made elsewhere.';
        show(hintMsg, true);
    } else {
        show(hintMsg, false);
    }
}

async function refresh() {
    const [stored, queryIds] = await Promise.all([
        getLocal(['syncState', 'listCache', 'listMeta', 'lastSync', 'needsFullSync']),
        getStoredQueryIds(),
    ]);
    render(
        stored.syncState as SyncState | undefined,
        (stored.listCache || {}) as ListCache,
        (stored.listMeta || {}) as ListMeta,
        queryIds,
        typeof stored.lastSync === 'number' ? stored.lastSync : undefined,
        stored.needsFullSync === true,
    );
}

function sendMessage(message: { type: string }): Promise<unknown> {
    return chrome.runtime.sendMessage(message);
}

syncBtn.addEventListener('click', () => {
    syncBtn.disabled = true;
    void sendMessage({ type: MSG.START_SYNC }).catch(() => {
        syncBtn.disabled = false;
        errorMsg.textContent = 'ListLens could not start the sync. Try again.';
        show(errorMsg, true);
    });
});

cancelBtn.addEventListener('click', () => {
    cancelBtn.disabled = true;
    progressLabel.textContent = 'Stopping…';
    void sendMessage({ type: MSG.CANCEL_SYNC }).catch(() => {
        errorMsg.textContent = 'Could not stop the sync. Reopen the popup to try again.';
        show(errorMsg, true);
    });
});

function openLists() {
    void chrome.tabs.create({ url: 'https://x.com/i/lists' });
    window.close();
}

openListsBtn.addEventListener('click', openLists);
reconnectBtn.addEventListener('click', openLists);

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;
    const relevant = Object.keys(changes).some((key) =>
        key === 'syncState'
        || key === 'listCache'
        || key === 'listMeta'
        || key === 'lastSync'
        || key === 'needsFullSync'
        || key.startsWith('queryId:'),
    );
    if (relevant) void refresh();
});

void refresh();
