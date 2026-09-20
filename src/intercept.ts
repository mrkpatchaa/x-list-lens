// Runs in the MAIN world so it can see X's own fetch/XHR traffic.
//
// Deliberately has NO runtime imports: a content script with imports gets wrapped
// in an async dynamic-import loader, which would leave window.fetch unpatched for
// the first moments of page load. The type-only import below is fully erased but
// still fails the build if these names ever drift from shared.ts.
import type { MSG } from './shared';

const QUERY_HARVESTED: typeof MSG.QUERY_HARVESTED = 'X_QUERY_HARVESTED';
const LIST_MUTATION: typeof MSG.LIST_MUTATION = 'X_LIST_MUTATION';

const HARVEST_OPERATIONS = ['ListsManagementPageTimeline', 'ListMembers', 'ListAddMember', 'ListRemoveMember'];
const GRAPHQL_RE = /\/i\/api\/graphql\/([^\/]+)\/([A-Za-z0-9_]+)/;

// Remember what we already reported so we don't postMessage on every GraphQL call.
const harvested = new Map<string, string>();

function harvestQueryId(url: string) {
    if (!url.includes('/i/api/graphql/')) return;
    const match = url.match(GRAPHQL_RE);
    if (!match) return;

    const [, queryId, operationName] = match;
    if (!HARVEST_OPERATIONS.includes(operationName)) return;
    if (harvested.get(operationName) === queryId) return;

    harvested.set(operationName, queryId);
    console.log(`[ListLens:Intercept] Harvested operationName: "${operationName}" with ID: "${queryId}"`);
    window.postMessage({ type: QUERY_HARVESTED, payload: { operationName, queryId } }, '*');
}

function isListMutation(url: string) {
    return url.includes('ListAddMember') || url.includes('ListRemoveMember');
}

// Announce the mutation only once the request has actually succeeded, so the
// background's re-fetch reads membership X has already committed.
function emitMutation(url: string, body: unknown) {
    try {
        let parsed: any = null;
        if (typeof body === 'string') parsed = JSON.parse(body);
        else if (body && typeof body === 'object') parsed = body;

        const variables = parsed?.variables;
        if (!variables?.listId) return;

        const action = url.includes('ListAddMember') ? 'add' : 'remove';
        console.log(`[ListLens:Intercept] Mutation committed -> Action: ${action}, Target User ID: ${variables.userId}, List ID: ${variables.listId}`);
        window.postMessage({
            type: LIST_MUTATION,
            payload: { userId: variables.userId, listId: variables.listId, action },
        }, '*');
    } catch (e) {
        console.error('[ListLens:Intercept] Failed to parse mutation body:', e);
    }
}

// Never let our bookkeeping break the page's own request.
function safely(fn: () => void) {
    try { fn(); } catch (e) { console.error('[ListLens:Intercept]', e); }
}

// 1. Monkey-patch window.fetch
const originalFetch = window.fetch;
window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    let body: unknown = null;
    let watch = false;

    safely(() => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        harvestQueryId(url);
        if (!isListMutation(url)) return;

        watch = true;
        // Must read the body BEFORE handing the Request to fetch - once fetch
        // starts consuming it, clone() throws and we'd break X's own call.
        body = init?.body ?? (input instanceof Request ? input.clone().text() : null);
    });

    const response = originalFetch.call(window, input, init);

    if (watch) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        Promise.all([response, body])
            .then(([res, resolvedBody]) => { if (res.ok) emitMutation(url, resolvedBody); })
            .catch(() => { /* network failure - nothing changed, nothing to sync */ });
    }

    return response;
};

// 2. Monkey-patch window.XMLHttpRequest (XHR)
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any)._url = typeof url === 'string' ? url : url.toString();
    return originalOpen.apply(this, [method, url, ...rest] as any);
};

XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    safely(() => {
        const url = (this as any)._url || '';
        if (!url) return;

        harvestQueryId(url);
        if (!isListMutation(url)) return;

        this.addEventListener('loadend', () => {
            if (this.status >= 200 && this.status < 300) emitMutation(url, body);
        }, { once: true });
    });

    return originalSend.apply(this, [body] as any);
};

console.log('[ListLens:Intercept] Both fetch and XHR successfully monkey-patched in MAIN world.');
