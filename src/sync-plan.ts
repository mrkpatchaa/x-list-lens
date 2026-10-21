import type { ListCache, ListCounts } from './shared'
import type { OwnedListSummary } from './list-ownership'

// A fast sync re-reads a list when it is new, when X gave no count, or when
// the count moved. A swap (one leaves, one joins) keeps the count: only a
// full sync catches that.
export function listsToReread(lists: OwnedListSummary[], stored: ListCounts, cachedIds: Set<string>): Set<string> {
    return new Set(lists
        .filter((list) => !cachedIds.has(list.id) || list.memberCount === undefined || list.memberCount !== stored[list.id])
        .map((list) => list.id))
}

// Keeps the cached memberships of keepIds, then adds the fresh members of the
// lists that were re-read. Handles left with no list are dropped.
export function buildNextCache(previous: ListCache, keepIds: Set<string>, fresh: Map<string, Set<string>>): ListCache {
    const next: ListCache = {}
    for (const [handle, listIds] of Object.entries(previous)) {
        const kept = listIds.filter((id) => keepIds.has(id))
        if (kept.length > 0) next[handle] = kept
    }
    for (const [listId, members] of fresh) {
        for (const handle of members) {
            if (!next[handle]) next[handle] = []
            if (!next[handle].includes(listId)) next[handle].push(listId)
        }
    }
    return next
}
