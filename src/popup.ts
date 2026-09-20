import { MSG, REQUIRED_OPERATIONS, LISTS_URL, getLocal, type ListCache, type ListMeta, type SyncState } from './shared';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const syncBtn = el<HTMLButtonElement>('syncBtn');
const cancelBtn = el<HTMLButtonElement>('cancelBtn');
const openListsBtn = el<HTMLButtonElement>('openListsBtn');
const setupNotice = el<HTMLDivElement>('setupNotice');
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

const BADGE_BASE = 'px-2 py-1 text-xs rounded-full ';
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function relativeTime(ts: number) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The background throws technical strings; none of them mean anything to a user.
function friendlyError(raw: string) {
    if (raw.includes('Not logged into X')) return 'You are not signed in to X. Sign in, then try again.';
    if (raw.includes('query ID')) return 'Open your Lists on X once, then try again.';
    if (raw.includes('429')) return 'X is rate-limiting us. Wait a few minutes and try again.';
    if (raw.includes('401') || raw.includes('403')) return 'X rejected the request. Try reloading x.com, then sync again.';
    if (raw.includes('HTTP error: 5')) return 'X is having trouble right now. Try again shortly.';
    if (raw.includes('parse list structures')) return 'Could not read your lists. Reload x.com and try again.';
    if (raw.includes('timed out') || raw.includes('TimeoutError')) return 'The request to X timed out. Check your connection.';
    return raw.replace(/^Error:\s*/, '');
}

function show(node: HTMLElement, visible: boolean, display = 'block') {
    node.classList.remove('hidden');
    node.style.display = visible ? display : 'none';
}

let ready = true;

function render(state: SyncState | undefined, cache: ListCache, meta: ListMeta, lastSync?: number) {
    const people = Object.keys(cache).length;
    const lists = Object.keys(meta).length;
    peopleCount.textContent = String(people);
    peopleWord.textContent = people === 1 ? 'person' : 'people';
    listCount.textContent = lists ? `across ${plural(lists, 'list')}` : 'no lists synced yet';
    lastSyncEl.textContent = lastSync ? `Last synced ${relativeTime(lastSync)}` : 'Never synced';

    const running = state?.status === 'running';
    show(progressWrap, running, 'flex');
    show(cancelBtn, running, 'block');
    show(setupNotice, !ready && !running, 'flex');

    syncBtn.disabled = running || !ready;
    syncBtn.setAttribute('aria-busy', String(running));

    if (running) {
        const { done, total, list } = state as { done: number; total: number; list?: string };
        progressBar.style.width = total ? `${Math.round((done / total) * 100)}%` : '5%';
        progressLabel.textContent = total ? `${done} of ${total} lists${list ? ` — ${list}` : ''}` : 'Reading your lists...';
        syncBtn.textContent = 'Syncing...';
        statusBadge.textContent = 'Running';
        statusBadge.className = BADGE_BASE + 'bg-blue-900 text-blue-300 motion-safe:animate-pulse';
        show(errorMsg, false);
        show(hintMsg, false);
        return;
    }

    if (state?.status === 'error') {
        syncBtn.textContent = 'Try Again';
        statusBadge.textContent = 'Failed';
        statusBadge.className = BADGE_BASE + 'bg-red-900 text-red-300';
        errorMsg.textContent = friendlyError(state.error);
        show(errorMsg, true);
        show(hintMsg, false);
        return;
    }

    syncBtn.textContent = lastSync ? 'Re-sync Lists' : 'Sync Lists Now';
    statusBadge.textContent = state?.status === 'done' ? 'Synced' : 'Idle';
    statusBadge.className = BADGE_BASE + (state?.status === 'done' ? 'bg-emerald-900 text-emerald-300' : 'bg-slate-800');
    show(errorMsg, false);

    const stale = lastSync !== undefined && Date.now() - lastSync > STALE_AFTER_MS;
    hintMsg.textContent = stale ? 'Your cache is over a week old — a re-sync will pick up changes made elsewhere.' : '';
    show(hintMsg, stale);
}

function refresh() {
    getLocal(['syncState', 'listCache', 'listMeta', 'lastSync', 'queryIds']).then((r) => {
        const queryIds = (r.queryIds || {}) as Record<string, string>;
        ready = REQUIRED_OPERATIONS.every((op) => Boolean(queryIds[op]));
        render(r.syncState, r.listCache || {}, r.listMeta || {}, r.lastSync);
    });
}

syncBtn.addEventListener('click', () => {
    cancelBtn.disabled = false;
    chrome.runtime.sendMessage({ type: MSG.START_SYNC });
});

cancelBtn.addEventListener('click', () => {
    cancelBtn.disabled = true;
    progressLabel.textContent = 'Stopping...';
    chrome.runtime.sendMessage({ type: MSG.CANCEL_SYNC });
});

// Sends the user to the one page that lets the interceptor harvest the query IDs.
openListsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: LISTS_URL });
    window.close();
});

// Storage-driven, so progress keeps updating and reopening the popup mid-sync
// still shows the real state.
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;
    if (changes.syncState || changes.listCache || changes.listMeta || changes.lastSync || changes.queryIds) refresh();
});

refresh();
