// Runs in the MAIN world so it can see X's own fetch/XHR traffic.
//
// Deliberately has NO runtime imports: a content script with imports gets wrapped
// in an async dynamic-import loader, which would leave window.fetch unpatched for
// the first moments of page load. The type-only import below is fully erased but
// still fails the build if these names drift from shared.ts.
import type { MSG } from './shared';

const QUERY_HARVESTED: typeof MSG.QUERY_HARVESTED = 'X_QUERY_HARVESTED';
const LIST_MUTATION: typeof MSG.LIST_MUTATION = 'X_LIST_MUTATION';

const HARVEST_OPERATIONS = ['ListsManagementPageTimeline', 'ListMembers', 'ListAddMember', 'ListRemoveMember'];
const GRAPHQL_RE = /\/i\/api\/graphql\/([^/]+)\/([A-Za-z0-9_]+)/;
const QUERY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ID_RE = /^\d{1,32}$/;

// Remember what we already reported so we don't postMessage on every GraphQL call.
const harvested = new Map<string, string>();
const xhrUrls = new WeakMap<XMLHttpRequest, string>();

function postToPage(message: unknown) {
    window.postMessage(message, window.location.origin);
}

function operationNameFromUrl(url: string): { queryId: string; operationName: string } | undefined {
    const match = url.match(GRAPHQL_RE);
    if (!match) return undefined;
    return { queryId: match[1], operationName: match[2] };
}

function harvestQueryId(url: string) {
    const operation = operationNameFromUrl(url);
    if (!operation || !QUERY_ID_RE.test(operation.queryId)) return;
    if (!HARVEST_OPERATIONS.includes(operation.operationName)) return;
    if (harvested.get(operation.operationName) === operation.queryId) return;

    harvested.set(operation.operationName, operation.queryId);
    console.log(`[ListLens:Intercept] Harvested operationName: "${operation.operationName}"`);
    postToPage({
        type: QUERY_HARVESTED,
        payload: { operationName: operation.operationName, queryId: operation.queryId },
    });
}

function isListMutation(url: string) {
    const operation = operationNameFromUrl(url);
    return operation?.operationName === 'ListAddMember' || operation?.operationName === 'ListRemoveMember';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSuccessfulGraphQLPayload(value: unknown): boolean {
    if (!isRecord(value)) return false;
    return !Array.isArray(value.errors) || value.errors.length === 0;
}

// Announce the mutation only once the request and GraphQL payload have actually
// succeeded, so the background re-fetch reads membership X has committed.
function emitMutation(url: string, body: unknown, responseBody: unknown) {
    try {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        if (!isSuccessfulGraphQLPayload(responseBody) || !isRecord(parsed) || !isRecord(parsed.variables)) return;

        const listId = String(parsed.variables.listId || '');
        const userId = String(parsed.variables.userId || '');
        if (!ID_RE.test(listId) || !ID_RE.test(userId)) return;

        const operation = operationNameFromUrl(url);
        const action = operation?.operationName === 'ListRemoveMember' ? 'remove' : 'add';
        console.log(`[ListLens:Intercept] Mutation committed -> Action: ${action}, List ID: ${listId}`);
        postToPage({
            type: LIST_MUTATION,
            payload: { userId, listId, action },
        });
    } catch (error) {
        console.error('[ListLens:Intercept] Failed to parse mutation response:', error);
    }
}

// Never let our bookkeeping break the page's own request.
function safely(fn: () => void) {
    try { fn(); } catch (error) { console.error('[ListLens:Intercept]', error); }
}

const originalFetch = window.fetch;
window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    let body: unknown = null;
    let watch = false;

    safely(() => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        harvestQueryId(url);
        if (!isListMutation(url)) return;

        watch = true;
        // Read the body before handing the Request to fetch; fetch consumes it.
        body = init?.body ?? (input instanceof Request ? input.clone().text() : null);
    });

    const response = originalFetch.call(window, input, init);

    if (watch) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        Promise.all([response, body])
            .then(async ([resolvedResponse, resolvedBody]) => {
                if (!resolvedResponse.ok) return;
                emitMutation(url, resolvedBody, await resolvedResponse.clone().json());
            })
            .catch(() => { /* network or non-JSON response - nothing changed */ });
    }

    return response;
};

const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    xhrUrls.set(this, typeof url === 'string' ? url : url.toString());
    return originalOpen.apply(this, [method, url, ...rest] as any);
};

XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    safely(() => {
        const url = xhrUrls.get(this) || '';
        if (!url) return;

        harvestQueryId(url);
        if (!isListMutation(url)) return;

        this.addEventListener('loadend', () => {
            if (this.status < 200 || this.status >= 300) return;
            try {
                emitMutation(url, body, JSON.parse(this.responseText));
            } catch {
                // A non-JSON response is not proof that the mutation succeeded.
            }
        }, { once: true });
    });

    return originalSend.apply(this, [body] as any);
};

console.log('[ListLens:Intercept] Fetch and XHR hooks installed.');
