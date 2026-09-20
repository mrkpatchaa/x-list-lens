// Shared across the three worlds (MAIN-world interceptor, content script, service
// worker). These message names were duplicated as bare string literals before,
// which is exactly how the add/remove bridge silently went missing.

export const MSG = {
    QUERY_HARVESTED: 'X_QUERY_HARVESTED',
    LIST_MUTATION: 'X_LIST_MUTATION',
    START_SYNC: 'START_SYNC',
    CANCEL_SYNC: 'CANCEL_SYNC',
} as const;

// The GraphQL operations we must have harvested before a sync can run at all.
export const REQUIRED_OPERATIONS = ['ListsManagementPageTimeline', 'ListMembers'] as const;
export const LISTS_URL = 'https://x.com/i/lists';

// A lowercased handle -> the IDs of the lists it belongs to.
export type ListCache = Record<string, string[]>;
// List ID -> current display name.
export type ListMeta = Record<string, string>;

export type SyncState =
    | { status: 'idle' }
    | { status: 'running'; done: number; total: number; list?: string }
    | { status: 'done' }
    | { status: 'error'; error: string };

// chrome.storage.local.get() is typed as {} - narrow it once, here.
export const getLocal = (keys: string[]) => chrome.storage.local.get(keys) as Promise<Record<string, any>>;
