import {
    getLocal,
    type FollowedLists,
    type ListCache,
    type ListColors,
    type ListCounts,
    type ListMeta,
    type SyncMode,
    type SyncState,
    type UserHandleIndex,
} from './shared';
import {
    buildListOwnershipsVariables,
    parseListManagementPage,
    parseOwnedListsPage,
    type OwnedListSummary,
} from './list-ownership';
import { collectListPages } from './list-pages';
import { createAbortError } from './abortable';
import { buildNextCache, listsToReread } from './sync-plan';

// listCache stores list IDs, not names (v1 stored names). Bump to discard old shapes.
export const CACHE_VERSION = 2;
const PAGE_SIZE = 100;
const INTER_LIST_DELAY_MS = 1000;
const MAX_MEMBER_PAGES = 200;

// Everything that talks to X or waits is injected, so a test can run a whole
// sync against canned responses.
export type SyncDeps = {
    fetchJson: (url: string, signal: AbortSignal) => Promise<unknown>;
    delay: (ms: number, signal: AbortSignal) => Promise<void>;
    currentUserId: string;
    queryIds: { lists: string; members: string; ownerships?: string };
    isCancelled: () => boolean;
    signal: AbortSignal;
};

const setSyncState = (syncState: SyncState) => chrome.storage.local.set({ syncState });

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
    deps: SyncDeps,
    onMember: (member: MemberIdentity) => void,
): Promise<{ members: Set<string>; truncated: boolean }> {
    const { signal, isCancelled: cancelled } = deps;
    const members = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor = '';
    let pageCount = 0;
    let pagesWithoutHandles = 0;
    let pagesWithoutNewMembers = 0;

    while (true) {
        if (pageCount >= MAX_MEMBER_PAGES) {
            console.warn(`[ListLens:Background] Stopped list ${listId} after ${MAX_MEMBER_PAGES} member pages.`);
            return { members, truncated: true };
        }
        const variables = JSON.stringify({ listId, count: PAGE_SIZE, cursor: cursor || undefined });
        const url = `https://x.com/i/api/graphql/${deps.queryIds.members}/ListMembers?variables=${encodeURIComponent(variables)}`;
        if (cancelled() || signal?.aborted) throw createAbortError();
        const page = parseMembersPage(await deps.fetchJson(url, signal));
        const handles = page.handles;
        const nextCursor = page.cursor;
        pageCount++;
        const before = members.size;

        for (const handle of handles) members.add(handle.toLowerCase());
        for (const member of page.members) onMember(member);
        console.debug(`[ListLens:Background] List ${listId} page ${pageCount}: ${handles.length} members (${members.size - before} new).`);

        if (handles.length === 0) {
            if (++pagesWithoutHandles >= 2) break;
        } else {
            pagesWithoutHandles = 0;
        }
        if (members.size === before) {
            if (++pagesWithoutNewMembers >= 2) break;
        } else {
            pagesWithoutNewMembers = 0;
        }

        if (cancelled()) break;
        if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;

        await deps.delay(Math.floor(Math.random() * 700) + 800, signal);
    }

    return { members, truncated: false };
}

async function fetchOwnedLists(
    queryId: string,
    operation: 'ListsManagementPageTimeline' | 'ListOwnerships',
    deps: SyncDeps,
): Promise<ListsRead> {
    const { currentUserId, signal, isCancelled: cancelled } = deps;
    console.info(`[ListLens:Background] Reading lists via ${operation}…`);
    const followed = new Map<string, OwnedListSummary>();
    const lists = await collectListPages(async (cursor) => {
        if (cancelled() || signal?.aborted) throw createAbortError();
        const variables = operation === 'ListOwnerships'
            ? buildListOwnershipsVariables(currentUserId, PAGE_SIZE, cursor)
            : JSON.stringify({ count: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        const url = `https://x.com/i/api/graphql/${queryId}/${operation}?variables=${encodeURIComponent(variables)}`;
        const payload = await deps.fetchJson(url, signal);
        const page = operation === 'ListOwnerships'
            ? parseOwnedListsPage(payload, currentUserId)
            : parseListManagementPage(payload, currentUserId);
        for (const list of page.followed) followed.set(list.id, list);
        return page;
    });

    console.info(`[ListLens:Background] ${operation} returned ${lists.length} owned and ${followed.size} followed lists.`);
    return { owned: lists, followed: [...followed.values()], followedKnown: operation === 'ListsManagementPageTimeline' };
}

// `followedKnown` is false on the ListOwnerships fallback, which cannot see
// followed lists. The stored followed lists are then kept as they are.
type ListsRead = { owned: OwnedListSummary[]; followed: OwnedListSummary[]; followedKnown: boolean };

async function readLists(deps: SyncDeps): Promise<ListsRead> {
    try {
        return await fetchOwnedLists(deps.queryIds.lists, 'ListsManagementPageTimeline', deps);
    } catch (managementError) {
        if (deps.isCancelled() || !deps.queryIds.ownerships) throw managementError;
        console.warn('[ListLens:Background] Lists management response failed; trying ListOwnerships.', managementError);
        return fetchOwnedLists(deps.queryIds.ownerships, 'ListOwnerships', deps);
    }
}

// Keeps each list's "included" choice. Only included followed lists are read.
function nextFollowedLists(read: ListsRead, stored: FollowedLists): FollowedLists {
    if (!read.followedKnown) return stored;
    return Object.fromEntries(read.followed.map((list) => [list.id, {
        name: list.name,
        included: stored[list.id]?.included === true,
        ...(list.memberCount !== undefined ? { memberCount: list.memberCount } : {}),
    }]));
}

// Returns 'cancelled' when the user stopped the sync. The previous cache is
// then left untouched rather than replaced by a partial one.
export async function runSync(requested: SyncMode, deps: SyncDeps): Promise<'done' | 'cancelled'> {
    await setSyncState({ status: 'running', done: 0, total: 0 });

    const stored = await getLocal(['listCache', 'listMeta', 'listCounts', 'lastFullSync', 'cacheVersion', 'userHandles', 'followedLists']);
    // A fast sync builds on a complete full sync. Without one, read everything.
    const mode: SyncMode = requested === 'fast'
        && typeof stored.lastFullSync === 'number'
        && stored.listCounts
        && stored.cacheVersion === CACHE_VERSION
        && stored.listCache && typeof stored.listCache === 'object'
        ? 'fast'
        : 'full';

    const read = await readLists(deps);
    const followedLists = nextFollowedLists(read, (stored.followedLists || {}) as FollowedLists);
    const ownedIds = new Set(read.owned.map((list) => list.id));
    const includedFollowed: OwnedListSummary[] = Object.entries(followedLists)
        .filter(([id, list]) => list.included && !ownedIds.has(id))
        .map(([id, list]) => ({ id, name: list.name, memberCount: list.memberCount }));
    const lists = [...read.owned, ...includedFollowed];
    const listMeta: ListMeta = {};
    const listCounts: ListCounts = {};
    for (const list of lists) {
        listMeta[list.id] = list.name;
        if (list.memberCount !== undefined) listCounts[list.id] = list.memberCount;
    }

    const previousIds = new Set(Object.keys((stored.listMeta || {}) as ListMeta));
    const toRead = mode === 'full'
        ? new Set(lists.map((list) => list.id))
        : listsToReread(lists, (stored.listCounts || {}) as ListCounts, previousIds);
    const keepIds = new Set(lists.map((list) => list.id).filter((id) => !toRead.has(id)));
    const removedCount = [...previousIds].filter((id) => !(id in listMeta)).length;
    const listsToRead = lists.filter((list) => toRead.has(list.id));

    console.info(`[ListLens:Background] ${mode} sync: reading members for ${listsToRead.length} of ${lists.length} lists.`);
    const nextUserHandles: UserHandleIndex = { ...(stored.userHandles || {}) };
    const fresh = new Map<string, Set<string>>();
    let done = 0;

    for (const list of listsToRead) {
        if (deps.isCancelled()) return 'cancelled';
        await setSyncState({ status: 'running', done, total: listsToRead.length, list: list.name });

        const { members, truncated } = await fetchListMembers(list.id, deps, (member) => { nextUserHandles[member.userId] = member.handle; });
        // A list cut short has no trustworthy count: leave it out, so the next fast sync reads it again.
        if (truncated) delete listCounts[list.id];
        if (deps.isCancelled()) return 'cancelled';
        fresh.set(list.id, members);
        done++;
        await deps.delay(INTER_LIST_DELAY_MS, deps.signal);
    }
    if (deps.isCancelled()) return 'cancelled';

    const previousCache = mode === 'fast' ? (stored.listCache || {}) as ListCache : {};
    const listCache = buildNextCache(previousCache, keepIds, fresh);
    const now = Date.now();
    const selfHandle = read.owned.find((list) => list.ownerHandle)?.ownerHandle;
    // Re-read the user's choices now: the popup stays usable during a sync,
    // and a color or Include set meanwhile must not be undone.
    const latest = await getLocal(['listColors', 'followedLists']);
    // A list deleted on X takes its color with it.
    const listColors = latest.listColors
        ? Object.fromEntries(Object.entries(latest.listColors as ListColors).filter(([id]) => id in listMeta))
        : undefined;
    const latestFollowed = (latest.followedLists || {}) as FollowedLists;
    for (const [id, list] of Object.entries(followedLists)) {
        if (id in latestFollowed) followedLists[id] = { ...list, included: latestFollowed[id].included === true };
    }
    await chrome.storage.local.set({
        ...(listColors ? { listColors } : {}),
        followedLists,
        listCache,
        listMeta,
        listCounts,
        userHandles: nextUserHandles,
        needsFullSync: false,
        lastSync: now,
        cacheVersion: CACHE_VERSION,
        ...(mode === 'full' ? { lastFullSync: now } : {}),
        ...(selfHandle ? { selfHandle } : {}),
    });
    console.info(`[ListLens:Background] ${mode} sync finished.`);
    await setSyncState({
        status: 'done',
        mode,
        at: now,
        listCount: lists.length,
        peopleCount: Object.keys(listCache).length,
        ...(mode === 'fast' ? { changedCount: toRead.size + removedCount } : {}),
    });
    return 'done';
}
