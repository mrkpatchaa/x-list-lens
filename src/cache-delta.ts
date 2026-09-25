import type { ListCache } from './shared'

export function applyMembershipDelta(
    cache: ListCache,
    listId: string,
    handle: string,
    action: 'add' | 'remove',
): ListCache {
    const next: ListCache = {}
    const normalizedHandle = handle.toLowerCase()

    for (const [cachedHandle, listIds] of Object.entries(cache)) {
        const updated = action === 'remove' && cachedHandle.toLowerCase() === normalizedHandle
            ? listIds.filter((id) => id !== listId)
            : listIds
        if (updated.length > 0) next[cachedHandle] = [...updated]
    }

    if (action === 'add') {
        const listIds = [...(next[normalizedHandle] || [])]
        if (!listIds.includes(listId)) listIds.push(listId)
        next[normalizedHandle] = listIds
    }

    return next
}
