import './badge.css';
import {
    MSG,
    getLocal,
    isListMutationMessage,
    isQueryHarvestedMessage,
    storeQueryId,
    type ListCache,
    type ListMeta,
} from './shared';

let listCache: ListCache = {};
let listMeta: ListMeta = {};

// UserCell covers list-member pages, followers, search results and "who to follow".
const TARGET_SELECTOR = '[data-testid="tweet"], [data-testid="UserName"], [data-testid="UserCell"]';
const HANDLE_ATTR = 'data-listlens-handle'; // also marks a node as already processed
const BADGE_CLASS = 'listlens-badge';
const TIP_CLASS = 'listlens-tip';
const NAMES_ATTR = 'data-listlens-names';
// Past this many mutated roots in one frame it's cheaper to sweep the document once.
const MAX_ROOTS_PER_FRAME = 40;
// Stop retrying a card that never yields a handle (ads, cards with no author).
const MAX_PAINT_ATTEMPTS = 10;

console.log('[ListLens:Content] Content script loaded. Initializing cache retrieval...');

getLocal(['listCache', 'listMeta']).then((result) => {
    const nextCache: ListCache = result.listCache || {};
    listMeta = result.listMeta || {};
    console.log(`[ListLens:Content] Loaded initial cache with ${Object.keys(nextCache).length} entries.`);
    applyCache(nextCache);
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;
    if (!changes.listCache && !changes.listMeta) return;

    if (changes.listMeta) listMeta = (changes.listMeta.newValue as ListMeta) || {};

    if (changes.listCache) {
        applyCache((changes.listCache.newValue as ListCache) || {});
    } else {
        repaint(null); // names changed - titles only
    }
});

// Bridge between the MAIN-world interceptor and the service worker.
window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;

    if (isQueryHarvestedMessage(event.data)) {
        void storeQueryId(event.data.payload.operationName, event.data.payload.queryId);
        return;
    }

    if (isListMutationMessage(event.data)) {
        void chrome.runtime
            .sendMessage({ type: MSG.LIST_MUTATION, payload: event.data.payload })
            .catch(() => { /* service worker asleep or extension reloaded */ });
    }
});

function findHandle(node: HTMLElement) {
    // Scope the scan to the username block instead of every span in the tweet.
    const scope = node.querySelector('[data-testid="User-Name"]') ?? node;

    for (const span of Array.from(scope.querySelectorAll('span'))) {
        const text = span.textContent;
        if (!text || text.length < 2 || text[0] !== '@' || text.includes(' ')) continue;
        return { handle: text.slice(1).toLowerCase(), span };
    }
    return null;
}

// Idempotent: safe to call again when a handle's lists change.
// Returns false when the node isn't rendered enough to read a handle off yet.
function paint(node: HTMLElement): boolean {
    const stale = node.querySelector(`.${BADGE_CLASS}`);
    if (stale) {
        if (stale === activeBadge) hideTip();
        stale.remove();
    }

    const found = findHandle(node);
    if (!found) {
        node.removeAttribute(HANDLE_ATTR);
        return false;
    }
    node.setAttribute(HANDLE_ATTR, found.handle);

    const listIds = listCache[found.handle];
    if (!listIds || listIds.length === 0) return true;

    const names = listIds.map((id) => listMeta[id] || id).join(', ');
    const badge = document.createElement('div');
    badge.className = BADGE_CLASS;
    badge.textContent = `📋 ${listIds.length}`;
    badge.setAttribute(NAMES_ATTR, names);
    badge.setAttribute('aria-label', `In ${listIds.length} ${listIds.length === 1 ? 'list' : 'lists'}: ${names}`);

    const parent = found.span.parentElement;
    if (parent) {
        parent.style.display = 'inline-flex';
        parent.style.alignItems = 'center';
        parent.appendChild(badge);
    }
    return true;
}

function sameLists(a: string[] = [], b: string[] = []) {
    return a.length === b.length && a.every((id) => b.includes(id));
}

// Only repaint nodes whose handle actually changed. A targeted sync touches one
// list, so tearing every badge off the timeline was both wasteful and visibly flickery.
function applyCache(next: ListCache) {
    const changed = new Set<string>();
    for (const handle of new Set([...Object.keys(listCache), ...Object.keys(next)])) {
        if (!sameLists(listCache[handle], next[handle])) changed.add(handle);
    }
    listCache = next;
    if (changed.size > 0) repaint(changed);
}

function repaint(changed: Set<string> | null) {
    for (const node of Array.from(document.querySelectorAll<HTMLElement>(`[${HANDLE_ATTR}]`))) {
        if (changed && !changed.has(node.getAttribute(HANDLE_ATTR)!)) continue;
        paint(node);
    }
    // Handles that just gained their first list have no painted node yet.
    scanDocument();
}

// ---------------------------------------------------------
// Hover tooltip - one delegated listener rather than handlers per badge.
// ---------------------------------------------------------
let tip: HTMLElement | null = null;
let activeBadge: Element | null = null;

function hideTip() {
    tip?.remove();
    tip = null;
    activeBadge = null;
}

function showTip(badge: HTMLElement) {
    const names = badge.getAttribute(NAMES_ATTR);
    if (!names) return;

    hideTip();
    activeBadge = badge;

    tip = document.createElement('div');
    tip.className = TIP_CLASS;
    tip.textContent = names;
    document.body.appendChild(tip);

    const anchor = badge.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - box.width / 2, window.innerWidth - box.width - 8));
    // Flip below the badge when there isn't room above it.
    const top = anchor.top - box.height - 6 < 8 ? anchor.bottom + 6 : anchor.top - box.height - 6;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
}

document.addEventListener('mouseover', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const badge = target.closest(`.${BADGE_CLASS}`);
    if (badge === activeBadge) return;
    if (badge) showTip(badge as HTMLElement);
    else if (activeBadge) hideTip();
}, true);

// A fixed-position tip would otherwise detach from a badge that scrolled away.
document.addEventListener('scroll', () => { if (activeBadge) hideTip(); }, true);
window.addEventListener('blur', hideTip);

const observed = new WeakSet<Element>();
const attempts = new WeakMap<Element, number>();

const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        const painted = paint(entry.target as HTMLElement);
        // Either way stop watching: leaving thousands of detached timeline nodes
        // under observation was leaking memory during long scrolls.
        observer.unobserve(entry.target);

        if (painted) {
            attempts.delete(entry.target);
        } else {
            // Not ready yet - let a later DOM mutation bring it back around.
            attempts.set(entry.target, (attempts.get(entry.target) ?? 0) + 1);
            observed.delete(entry.target);
        }
    }
}, { rootMargin: '200px' });

function track(el: Element) {
    if (observed.has(el)) return;
    if ((attempts.get(el) ?? 0) >= MAX_PAINT_ATTEMPTS) return;
    observed.add(el);
    observer.observe(el);
}

function scanRoot(root: Element) {
    if (root.matches(TARGET_SELECTOR)) track(root);
    for (const el of Array.from(root.querySelectorAll(TARGET_SELECTOR))) track(el);
}

function scanDocument() {
    for (const el of Array.from(document.querySelectorAll(TARGET_SELECTOR))) track(el);
}

// X churns the DOM constantly. Coalesce a burst of mutations into one pass per
// frame, and search only the subtrees that actually changed.
const pendingRoots = new Set<Element>();
let needsFullScan = false;
let scanScheduled = false;

function schedule() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
        scanScheduled = false;
        if (needsFullScan) {
            needsFullScan = false;
            pendingRoots.clear();
            scanDocument();
            return;
        }
        for (const root of pendingRoots) {
            if (root.isConnected) scanRoot(root);
        }
        pendingRoots.clear();
    });
}

function addRoot(el: Element) {
    if (pendingRoots.size >= MAX_ROOTS_PER_FRAME) needsFullScan = true;
    else pendingRoots.add(el);
}

const mutationObserver = new MutationObserver((records) => {
    for (const record of records) {
        // A newly inserted subtree may contain whole cards.
        for (const node of record.addedNodes) {
            if (node instanceof Element) addRoot(node);
        }

        // X frequently renders a card first and fills the @handle in afterwards.
        // That arrives as a Text node, so there is no Element above to pick up and
        // a card that failed its first paint would never be retried. Re-offer the
        // enclosing card - but only while it is still unresolved, so a timeline of
        // settled cards doesn't re-enter the scan on every unrelated mutation.
        const host = record.target instanceof Element ? record.target.closest(TARGET_SELECTOR) : null;
        if (host && !observed.has(host) && !host.hasAttribute(HANDLE_ATTR)) addRoot(host);
    }
    if (needsFullScan || pendingRoots.size > 0) schedule();
});

mutationObserver.observe(document.body, { childList: true, subtree: true });

// Catch anything already on the page at document_idle.
scanDocument();
