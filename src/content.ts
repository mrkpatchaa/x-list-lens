import './badge.css';
import { BADGE_TARGET_SELECTOR, findHandle, formatListNames } from './dom-badge';
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
const TARGET_SELECTOR = BADGE_TARGET_SELECTOR;
const HANDLE_ATTR = 'data-listlens-handle';
const BADGE_CLASS = 'listlens-badge';
const TIP_CLASS = 'listlens-tip';
const NAMES_ATTR = 'data-listlens-names';
const MAX_ROOTS_PER_FRAME = 40;
const MAX_PAINT_ATTEMPTS = 10;
const TIP_ID = 'listlens-tip';

console.info('[ListLens:Content] Content script loaded.');

getLocal(['listCache', 'listMeta']).then((result) => {
    const nextCache: ListCache = result.listCache || {};
    listMeta = result.listMeta || {};
    applyCache(nextCache);
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;
    if (!changes.listCache && !changes.listMeta) return;

    if (changes.listMeta) listMeta = (changes.listMeta.newValue as ListMeta) || {};

    if (changes.listCache) {
        applyCache((changes.listCache.newValue as ListCache) || {});
    } else {
        repaint(null);
    }
});

// Bridge between the MAIN-world interceptor and the extension contexts. The page
// is untrusted, so only allowlisted, bounded messages cross this boundary.
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

function sameLists(a: string[] = [], b: string[] = []) {
    return a.length === b.length && a.every((id) => b.includes(id));
}

function directBadges(parent: HTMLElement) {
    return Array.from(parent.children).filter((child): child is HTMLElement => child.classList.contains(BADGE_CLASS));
}

type LayoutState = { display: string; alignItems: string };
const layoutHosts = new WeakMap<HTMLElement, LayoutState>();

function restoreLayout(parent: HTMLElement) {
    const previous = layoutHosts.get(parent);
    if (!previous) return;
    if (parent.style.display === 'inline-flex') parent.style.display = previous.display;
    if (parent.style.alignItems === 'center') parent.style.alignItems = previous.alignItems;
    layoutHosts.delete(parent);
}

function removeBadges(parent: HTMLElement) {
    const badges = directBadges(parent);
    for (const badge of badges) {
        if (badge === activeBadge) hideTip();
        badge.remove();
    }
    if (badges.length > 0 && directBadges(parent).length === 0) restoreLayout(parent);
    return badges.length > 0;
}

function createBadgeIcon() {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    icon.classList.add('listlens-badge-icon');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M5 2.5h6a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm2-1h2v2H7v-2Zm-2 5h6v1H5v-1Zm0 2.5h4v1H5V9Z');
    path.setAttribute('fill', 'currentColor');
    icon.appendChild(path);
    return icon;
}

// Idempotent: safe to call again when a handle's lists change.
function paint(node: HTMLElement): boolean {
    const found = findHandle(node);
    const parent = found?.link.parentElement;
    if (!found || !parent) {
        for (const stale of Array.from(node.querySelectorAll<HTMLElement>(`.${BADGE_CLASS}`))) {
            if (stale.parentElement) removeBadges(stale.parentElement);
        }
        node.removeAttribute(HANDLE_ATTR);
        return false;
    }

    removeBadges(parent);
    node.setAttribute(HANDLE_ATTR, found.handle);

    const listIds = listCache[found.handle];
    if (!listIds || listIds.length === 0) return true;

    const names = formatListNames(listIds, listMeta);
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = BADGE_CLASS;
    badge.setAttribute(NAMES_ATTR, names);
    badge.setAttribute('aria-label', `In ${listIds.length} ${listIds.length === 1 ? 'list' : 'lists'}: ${names}`);
    badge.setAttribute('aria-expanded', 'false');

    const count = document.createElement('span');
    count.className = 'listlens-badge-count';
    count.textContent = String(listIds.length);
    badge.append(createBadgeIcon(), count);

    if (!layoutHosts.has(parent)) {
        layoutHosts.set(parent, { display: parent.style.display, alignItems: parent.style.alignItems });
    }
    parent.style.display = 'inline-flex';
    parent.style.alignItems = 'center';
    parent.appendChild(badge);
    return true;
}

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
// Tooltip - one delegated listener rather than handlers per badge.
// ---------------------------------------------------------
let tip: HTMLElement | null = null;
let activeBadge: Element | null = null;

function hideTip() {
    if (activeBadge instanceof HTMLElement) {
        activeBadge.removeAttribute('aria-describedby');
        activeBadge.setAttribute('aria-expanded', 'false');
    }
    tip?.remove();
    tip = null;
    activeBadge = null;
}

function showTip(badge: HTMLElement) {
    const names = badge.getAttribute(NAMES_ATTR);
    if (!names) return;

    hideTip();
    activeBadge = badge;
    badge.setAttribute('aria-describedby', TIP_ID);
    badge.setAttribute('aria-expanded', 'true');

    tip = document.createElement('div');
    tip.id = TIP_ID;
    tip.className = TIP_CLASS;
    tip.setAttribute('role', 'tooltip');
    tip.textContent = names;
    document.body.appendChild(tip);

    const anchor = badge.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - box.width / 2, window.innerWidth - box.width - 8));
    const top = anchor.top - box.height - 6 < 8 ? anchor.bottom + 6 : anchor.top - box.height - 6;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
}

function badgeFromTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const badge = target.closest(`.${BADGE_CLASS}`);
    return badge instanceof HTMLElement ? badge : null;
}

document.addEventListener('pointerover', (event) => {
    const badge = badgeFromTarget(event.target);
    if (!badge) {
        if (activeBadge) hideTip();
        return;
    }
    if (badge !== activeBadge) showTip(badge);
}, true);

document.addEventListener('focusin', (event) => {
    const badge = badgeFromTarget(event.target);
    if (badge) showTip(badge);
}, true);

document.addEventListener('click', (event) => {
    const badge = badgeFromTarget(event.target);
    if (badge) showTip(badge);
    else if (activeBadge) hideTip();
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeBadge) hideTip();
});

document.addEventListener('scroll', () => { if (activeBadge) hideTip(); }, true);
window.addEventListener('blur', hideTip);

const observed = new WeakSet<Element>();
const attempts = new WeakMap<Element, number>();

const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        const painted = paint(entry.target as HTMLElement);
        observer.unobserve(entry.target);

        if (painted) {
            attempts.delete(entry.target);
            observed.delete(entry.target);
        } else {
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

function containsBadge(node: Node) {
    return node instanceof Element && (node.classList.contains(BADGE_CLASS) || Boolean(node.querySelector(`.${BADGE_CLASS}`)));
}

function isOwnMutation(record: MutationRecord) {
    return Array.from(record.addedNodes).some(containsBadge)
        || Array.from(record.removedNodes).some(containsBadge)
        || (record.target instanceof Element && Boolean(record.target.closest(`.${BADGE_CLASS}`)));
}

const mutationObserver = new MutationObserver((records) => {
    for (const record of records) {
        // Our badge insertion/removal must not trigger an endless repaint loop.
        if (isOwnMutation(record)) continue;

        for (const node of record.addedNodes) {
            if (node instanceof Element) addRoot(node);
        }

        // React can update an existing handle text node in place.
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        const host = target?.closest(TARGET_SELECTOR) || null;
        if (host) {
            const knownHandle = host.getAttribute(HANDLE_ATTR) || '';
            const currentHandle = findHandle(host as HTMLElement)?.handle || '';
            if (currentHandle !== knownHandle && !observed.has(host)) {
                observer.unobserve(host);
                observed.delete(host);
                attempts.delete(host);
                addRoot(host);
            }
        }
    }
    if (needsFullScan || pendingRoots.size > 0) schedule();
});

mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

// Catch anything already on the page at document_idle.
scanDocument();
