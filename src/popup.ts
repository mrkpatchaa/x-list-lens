import {
    MSG,
    X_ORIGINS,
    getLocal,
    getMissingOperations,
    getStoredQueryIds,
    type FollowedLists,
    type ListCache,
    type ListColors,
    type HookStatus,
    type ListMeta,
    type QueryIds,
    type SyncMode,
    type SyncState,
} from './shared';
import { LIST_COLORS, listColor } from './palette';
import { buildExportFile, downloadBlob, needsExportTab, type ExportFormat } from './export-download';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const syncBtn = el<HTMLButtonElement>('syncBtn');
const syncLabel = el<HTMLSpanElement>('syncLabel');
const cancelBtn = el<HTMLButtonElement>('cancelBtn');
const openListsBtn = el<HTMLButtonElement>('openListsBtn');
const openListsLabel = el<HTMLSpanElement>('openListsLabel');
const reconnectBtn = el<HTMLButtonElement>('reconnectBtn');
const fullSyncBtn = el<HTMLButtonElement>('fullSyncBtn');
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
const listsSection = el<HTMLElement>('listsSection');
const listsCount = el<HTMLSpanElement>('listsCount');
const listsSearch = el<HTMLInputElement>('listsSearch');
const listsList = el<HTMLDivElement>('listsList');
const listsEmpty = el<HTMLParagraphElement>('listsEmpty');
const unlistedToggle = el<HTMLInputElement>('unlistedToggle');
const followedGroup = el<HTMLDivElement>('followedGroup');
const followedList = el<HTMLDivElement>('followedList');
const exportCsvBtn = el<HTMLButtonElement>('exportCsvBtn');
const exportJsonBtn = el<HTMLButtonElement>('exportJsonBtn');
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
            return 'X did not accept your session. Sign in to X in this browser, then try again.';
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

let listFilter = '';
let expandedListId: string | null = null;
let currentCache: ListCache = {};
let currentMeta: ListMeta = {};
let currentColors: ListColors = {};
let currentFollowed: FollowedLists = {};
const MAX_VISIBLE_MEMBERS = 50;

function membersForList(cache: ListCache, listId: string): string[] {
    return Object.entries(cache)
        .filter(([, listIds]) => listIds.includes(listId))
        .map(([handle]) => handle)
        .sort((a, b) => a.localeCompare(b));
}

function createChevron(expanded: boolean) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    icon.classList.add('h-3.5', 'w-3.5', 'shrink-0', 'text-slate-500');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', expanded ? 'm4 6 4 4 4-4' : 'm4 10 4-4 4 4');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    icon.appendChild(path);
    return icon;
}

// Cycles no color -> each palette color -> no color.
function createSwatch(id: string, name: string) {
    const color = listColor(currentColors[id]);
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'ml-1 h-4 w-4 shrink-0 rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-400 '
        + (color ? 'border-transparent' : 'border-dashed border-slate-600 hover:border-slate-400');
    if (color) swatch.style.backgroundColor = color.hex;
    swatch.setAttribute('aria-label', `Color for ${name}: ${color ? color.name : 'none'}`);
    swatch.title = 'Change color';
    swatch.addEventListener('click', () => {
        const current = currentColors[id];
        const next = typeof current !== 'number' ? 0 : current + 1 < LIST_COLORS.length ? current + 1 : undefined;
        const nextColors = { ...currentColors };
        if (next === undefined) delete nextColors[id];
        else nextColors[id] = next;
        currentColors = nextColors;
        renderLists(currentCache, currentMeta);
        void chrome.storage.local.set({ listColors: nextColors });
    });
    return swatch;
}

function renderFollowed() {
    const entries = Object.entries(currentFollowed).sort(([, a], [, b]) => a.name.localeCompare(b.name));
    followedGroup.classList.toggle('hidden', entries.length === 0);
    followedList.replaceChildren();
    for (const [id, list] of entries) {
        const row = document.createElement('label');
        row.className = 'flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-slate-800/80';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = list.included;
        box.className = 'h-3.5 w-3.5 shrink-0 accent-blue-500';
        box.setAttribute('aria-label', `Include ${list.name}`);
        box.addEventListener('change', () => {
            currentFollowed = { ...currentFollowed, [id]: { ...list, included: box.checked } };
            void chrome.storage.local.set({ followedLists: currentFollowed });
        });
        const name = document.createElement('span');
        name.className = 'min-w-0 flex-1 truncate text-slate-200';
        name.textContent = list.name;
        row.append(box, name);
        if (list.memberCount !== undefined) {
            const count = document.createElement('span');
            count.className = 'shrink-0 text-[11px] tabular-nums text-slate-500';
            count.textContent = plural(list.memberCount, 'member');
            row.appendChild(count);
        }
        followedList.appendChild(row);
    }
}

function renderLists(cache: ListCache, meta: ListMeta) {
    renderFollowed();
    // Followed lists you include sit in listMeta too, but have their own group.
    const entries = Object.entries(meta)
        .filter(([id]) => !(id in currentFollowed))
        .map(([id, name]) => ({ id, name, count: membersForList(cache, id).length }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const query = listFilter.trim().toLowerCase();
    const filtered = entries.filter(({ name }) => !query || name.toLowerCase().includes(query));

    show(listsSection, entries.length > 0 || Object.keys(currentFollowed).length > 0);
    listsCount.textContent = plural(entries.length, 'list');
    listsList.replaceChildren();
    listsEmpty.hidden = filtered.length > 0;
    listsEmpty.textContent = entries.length === 0
        ? 'No synced lists yet.'
        : 'No lists match that filter.';

    for (const { id, name, count } of filtered) {
        const item = document.createElement('div');
        item.setAttribute('role', 'listitem');
        item.className = 'rounded-lg';

        const row = document.createElement('div');
        row.className = 'flex items-center gap-1';

        row.appendChild(createSwatch(id, name));

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-slate-800/80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-400';
        toggle.setAttribute('aria-expanded', String(expandedListId === id));
        toggle.title = expandedListId === id ? `Hide members in ${name}` : `Show members in ${name}`;

        const label = document.createElement('span');
        label.className = 'min-w-0 truncate text-xs font-medium text-slate-200';
        label.textContent = name;
        const countLabel = document.createElement('span');
        countLabel.className = 'shrink-0 text-[11px] tabular-nums text-slate-500';
        countLabel.textContent = plural(count, 'person', 'people');
        toggle.append(label, countLabel, createChevron(expandedListId === id));
        toggle.addEventListener('click', () => {
            expandedListId = expandedListId === id ? null : id;
            renderLists(currentCache, currentMeta);
        });
        row.appendChild(toggle);

        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'shrink-0 rounded-md px-2 py-1.5 text-[11px] text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-400';
        open.textContent = 'Open';
        open.title = `Open ${name} on X`;
        open.addEventListener('click', () => {
            void chrome.tabs.create({ url: `https://x.com/i/lists/${encodeURIComponent(id)}` });
            window.close();
        });
        row.appendChild(open);
        item.appendChild(row);

        if (expandedListId === id) {
            const members = membersForList(cache, id);
            const memberList = document.createElement('div');
            memberList.className = 'ml-2 mt-1 max-h-24 space-y-0.5 overflow-y-auto border-l border-slate-800 pl-2';
            if (members.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'px-2 py-1.5 text-[11px] text-slate-500';
                empty.textContent = 'No cached members.';
                memberList.appendChild(empty);
            } else {
                for (const handle of members.slice(0, MAX_VISIBLE_MEMBERS)) {
                    const member = document.createElement('button');
                    member.type = 'button';
                    member.className = 'block w-full rounded-md px-2 py-1 text-left text-[11px] text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-400';
                    member.textContent = `@${handle}`;
                    member.addEventListener('click', () => {
                        void chrome.tabs.create({ url: `https://x.com/${encodeURIComponent(handle)}` });
                        window.close();
                    });
                    memberList.appendChild(member);
                }
                if (members.length > MAX_VISIBLE_MEMBERS) {
                    const more = document.createElement('p');
                    more.className = 'px-2 py-1.5 text-[11px] text-slate-500';
                    more.textContent = `+${members.length - MAX_VISIBLE_MEMBERS} more`;
                    memberList.appendChild(more);
                }
            }
            item.appendChild(memberList);
        }

        listsList.appendChild(item);
    }
}

listsSearch.addEventListener('input', () => {
    listFilter = listsSearch.value;
    renderLists(currentCache, currentMeta);
});

// Chrome grants host access at install. Safari asks the user per site, and
// until then nothing runs on x.com and setup can never finish.
type Environment = { hostAccess: boolean; hookStatus?: HookStatus };
let setupAction: 'openLists' | 'grantAccess' = 'openLists';

async function hasHostAccess(): Promise<boolean> {
    if (!chrome.permissions?.contains) return true;
    try {
        return await chrome.permissions.contains({ origins: ['https://x.com/*'] });
    } catch {
        return true;
    }
}

function renderSetup(queryIds: QueryIds, env: Environment) {
    if (!env.hostAccess) {
        setupAction = 'grantAccess';
        setupEyebrow.textContent = 'Permission needed';
        setupTitle.textContent = 'Allow ListLens on x.com';
        setupCopy.textContent = 'Your browser has not given ListLens access to x.com yet. Without it, ListLens cannot learn your Lists or show badges. Choose “Always Allow” when asked.';
        openListsLabel.textContent = 'Allow on x.com';
        setupListsStep.className = 'setup-step setup-step-pending';
        setupListStep.className = 'setup-step setup-step-pending';
        return;
    }

    setupAction = 'openLists';
    const missing = getMissingOperations(queryIds);
    const needsListMembers = missing.includes('ListMembers');
    const needsLists = missing.includes('ListsManagementPageTimeline');

    setupEyebrow.textContent = missing.length === 2 ? 'One-time setup' : 'Almost there';
    setupTitle.textContent = missing.length === 2
        ? 'Connect to your Lists'
        : needsListMembers ? 'Open one of your lists' : 'Open your Lists on X';
    setupCopy.textContent = missing.length === 2
        ? 'Open your Lists page, then open one of your lists so ListLens can learn both requests.'
        : needsListMembers
            ? 'Open any list from your Lists page so ListLens can learn the member request.'
            : 'Open your Lists page on X once so ListLens can learn the current request format.';
    openListsLabel.textContent = 'Open Lists on X';
    if (env.hookStatus === 'isolated' || env.hookStatus === 'missing') {
        // The content script ran, but the request watcher did not run inside the page.
        setupEyebrow.textContent = 'Setup is blocked';
        setupCopy.textContent = 'ListLens is on x.com, but this browser did not let it watch X’s requests. Reload your x.com tabs and try again. If this message stays, this browser cannot run the request watcher yet.';
    }

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
    env: Environment = { hostAccess: true },
    lastFullSync?: number,
) {
    hasFullSync = lastFullSync !== undefined;
    const people = Object.keys(cache).length;
    const lists = Object.keys(meta).length;
    const running = state?.status === 'running';
    const error = state?.status === 'error' ? state : undefined;
    const done = state?.status === 'done' ? state : undefined;
    const cancelled = state?.status === 'cancelled' ? state : undefined;
    const ready = env.hostAccess && getMissingOperations(queryIds).length === 0;
    currentCache = cache;
    currentMeta = meta;

    peopleCount.textContent = numberFormat.format(people);
    peopleWord.textContent = people === 1 ? 'person' : 'people';
    listCount.textContent = lists ? `Across ${plural(lists, 'list')}` : 'No lists synced yet';
    renderLists(cache, meta);
    lastSyncEl.textContent = lastSync ? `Last synced ${relativeTime(lastSync)}` : 'Never synced';

    renderSetup(queryIds, env);
    show(setupNotice, !ready && !running, 'flex');
    show(progressWrap, running, 'flex');
    show(cancelBtn, running, 'block');
    reconnectBtn.disabled = running;

    syncBtn.disabled = running || !ready;
    exportCsvBtn.disabled = !lastSync;
    exportJsonBtn.disabled = !lastSync;
    fullSyncBtn.disabled = running || !ready;
    syncBtn.setAttribute('aria-busy', String(running));
    cancelBtn.disabled = state?.status === 'running' && state.cancelRequested === true;

    if (running && state.status === 'running') {
        const { done: completed, total, list, cancelRequested } = state;
        const percent = total ? Math.round((completed / total) * 100) : 5;
        progressBar.style.width = `${percent}%`;
        progressBar.setAttribute('aria-valuenow', String(percent));
        progressLabel.textContent = total
            ? `${completed} of ${total} lists${list ? ` — ${list}` : ''}`
            : 'Checking your lists…';
        syncLabel.textContent = 'Syncing…';
        setStatus(cancelRequested ? 'Stopping' : 'Syncing', 'running');
        show(errorMsg, false);
        show(hintMsg, false);
        return;
    }

    if (error) {
        syncLabel.textContent = 'Try again';
        setStatus('Needs attention', 'error');
        const detail = error.code === 'auth' || error.code === 'http' || error.code === 'unknown' ? error.error : '';
        errorMsg.textContent = friendlyError(error) + (detail ? ` Details: ${detail}` : '');
        show(errorMsg, true);
    } else if (cancelled) {
        syncLabel.textContent = 'Sync again';
        setStatus('Stopped', 'cancelled');
        show(errorMsg, false);
    } else if (done) {
        syncLabel.textContent = 'Re-sync lists';
        setStatus('Synced', 'done');
        show(errorMsg, false);
    } else {
        syncLabel.textContent = lastSync ? 'Re-sync lists' : 'Sync lists';
        setStatus(ready ? 'Ready' : 'Checking', ready ? 'ready' : 'checking');
        show(errorMsg, false);
    }

    // A fast sync cannot catch a swap (one person leaves, one joins), so the
    // nudge counts from the last full sync.
    const lastFull = lastFullSync ?? lastSync;
    const stale = lastFull !== undefined && Date.now() - lastFull > STALE_AFTER_MS;
    if (needsFullSync) {
        hintMsg.textContent = 'A list change could not be matched to a cached profile. Run a full sync when convenient.';
        show(hintMsg, true);
    } else if (cancelled) {
        hintMsg.textContent = 'Sync stopped. Your previous badges are still available.';
        show(hintMsg, true);
    } else if (done && done.listCount === 0) {
        hintMsg.textContent = 'No lists found. Create a list on X, then sync again.';
        show(hintMsg, true);
    } else if (ready && (env.hookStatus === 'isolated' || env.hookStatus === 'missing')) {
        hintMsg.textContent = 'This browser hides X’s requests from ListLens, so list changes you make on X are not picked up. Re-sync after you change a list.';
        show(hintMsg, true);
    } else if (stale && !error) {
        hintMsg.textContent = 'Your last full sync is over a week old — run a full sync to catch changes made elsewhere.';
        show(hintMsg, true);
    } else if (done?.mode === 'fast' && done.changedCount !== undefined) {
        hintMsg.textContent = `${numberFormat.format(done.changedCount)} of ${plural(done.listCount ?? 0, 'list')} changed.`;
        show(hintMsg, true);
    } else {
        show(hintMsg, false);
    }
}

async function refresh() {
    const [stored, queryIds, hostAccess] = await Promise.all([
        getLocal(['syncState', 'listCache', 'listMeta', 'lastSync', 'lastFullSync', 'needsFullSync', 'hookStatus', 'showUnlistedMarker', 'listColors', 'followedLists']),
        getStoredQueryIds(),
        hasHostAccess(),
    ]);
    unlistedToggle.checked = stored.showUnlistedMarker === true;
    currentColors = (stored.listColors || {}) as ListColors;
    currentFollowed = (stored.followedLists || {}) as FollowedLists;
    render(
        stored.syncState as SyncState | undefined,
        (stored.listCache || {}) as ListCache,
        (stored.listMeta || {}) as ListMeta,
        queryIds,
        typeof stored.lastSync === 'number' ? stored.lastSync : undefined,
        stored.needsFullSync === true,
        { hostAccess, hookStatus: stored.hookStatus as HookStatus | undefined },
        typeof stored.lastFullSync === 'number' ? stored.lastFullSync : undefined,
    );
}

// Safari stops idle extension workers more readily than Chrome. If the worker
// died mid-sync, storage still says "running" and the popup would wait forever.
async function detectInterruptedSync() {
    const { syncState } = await getLocal(['syncState']);
    if ((syncState as SyncState | undefined)?.status !== 'running') return;
    let running = false;
    try {
        const reply = await chrome.runtime.sendMessage({ type: MSG.SYNC_STATUS }) as { running?: boolean } | undefined;
        running = reply?.running === true;
    } catch {
        // No worker answered, so no sync is running.
    }
    if (running) return;
    const interrupted: SyncState = {
        status: 'error',
        at: Date.now(),
        error: 'The background worker stopped during the sync.',
        code: 'interrupted',
    };
    await chrome.storage.local.set({ syncState: interrupted });
}

function sendMessage(message: { type: string; mode?: SyncMode }): Promise<unknown> {
    return chrome.runtime.sendMessage(message);
}

// The main button runs a fast sync once a full sync exists. The footer button
// always runs a full one.
let hasFullSync = false;

function startSync(mode: SyncMode) {
    console.info(`[ListLens:Popup] ${mode} sync requested.`);
    syncBtn.disabled = true;
    fullSyncBtn.disabled = true;
    void sendMessage({ type: MSG.START_SYNC, mode }).catch(() => {
        syncBtn.disabled = false;
        fullSyncBtn.disabled = false;
        errorMsg.textContent = 'ListLens could not start the sync. Try again.';
        show(errorMsg, true);
    });
}

syncBtn.addEventListener('click', () => startSync(hasFullSync ? 'fast' : 'full'));
fullSyncBtn.addEventListener('click', () => startSync('full'));
function exportLists(format: ExportFormat) {
    if (needsExportTab()) {
        void chrome.tabs.create({ url: chrome.runtime.getURL(`export.html?format=${format}`) });
        return;
    }
    void buildExportFile(format)
        .then(({ name, blob }) => { downloadBlob(name, blob); })
        .catch(() => {
            errorMsg.textContent = 'ListLens could not build the export. Try again.';
            show(errorMsg, true);
        });
}

exportCsvBtn.addEventListener('click', () => exportLists('csv'));
exportJsonBtn.addEventListener('click', () => exportLists('json'));
unlistedToggle.addEventListener('change', () => {
    void chrome.storage.local.set({ showUnlistedMarker: unlistedToggle.checked });
});

cancelBtn.addEventListener('click', () => {
    console.info('[ListLens:Popup] Cancellation requested.');
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

function grantAccess() {
    // Must run inside the click: browsers only show the prompt for a user gesture.
    void chrome.permissions.request({ origins: X_ORIGINS })
        .then(() => refresh())
        .catch(() => {
            errorMsg.textContent = 'ListLens could not ask for access. Allow it from the browser’s extension settings for x.com.';
            show(errorMsg, true);
        });
}

openListsBtn.addEventListener('click', () => {
    if (setupAction === 'grantAccess') grantAccess();
    else openLists();
});
reconnectBtn.addEventListener('click', openLists);

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;
    const relevant = Object.keys(changes).some((key) =>
        key === 'syncState'
        || key === 'listCache'
        || key === 'listMeta'
        || key === 'lastSync'
        || key === 'lastFullSync'
        || key === 'listColors'
        || key === 'followedLists'
        || key === 'needsFullSync'
        || key === 'hookStatus'
        || key.startsWith('queryId:'),
    );
    if (relevant) void refresh();
});

chrome.permissions?.onAdded?.addListener(() => { void refresh(); });
chrome.permissions?.onRemoved?.addListener(() => { void refresh(); });

void detectInterruptedSync().finally(() => refresh());
