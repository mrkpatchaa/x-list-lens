import { getLocal, type ListCache, type ListCounts, type ListMutationMessage, type UserHandleIndex } from './shared'

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

// Applied from the content script that saw the mutation, not the service
// worker: Safari may not wake the worker for it, and the page repaints at once.
export async function applyListMutationToStorage(
    payload: ListMutationMessage['payload'],
    pageHandle?: string,
): Promise<ListCache | undefined> {
    const { listCache, userHandles, listCounts } = await getLocal(['listCache', 'userHandles', 'listCounts'])
    const index = (userHandles || {}) as UserHandleIndex
    // X's reply rarely names the user, so fall back to the index, then to the page.
    const handle = payload.handle || index[payload.userId] || pageHandle

    if (!handle) {
        await chrome.storage.local.set({ needsFullSync: true })
        console.warn(`[ListLens:Content] No cached handle for user ${payload.userId}; full sync required.`)
        return undefined
    }

    const nextCache = applyMembershipDelta((listCache || {}) as ListCache, payload.listId, handle, payload.action)
    const nextIndex = { ...index, [payload.userId]: handle.toLowerCase() }
    // Keep X's count in step, so the next fast sync does not re-read this list for nothing.
    const counts = (listCounts || {}) as ListCounts
    const nextCounts = payload.listId in counts
        ? { ...counts, [payload.listId]: Math.max(0, counts[payload.listId] + (payload.action === 'add' ? 1 : -1)) }
        : counts
    await chrome.storage.local.set({ listCache: nextCache, userHandles: nextIndex, ...(listCounts ? { listCounts: nextCounts } : {}) })
    console.info(`[ListLens:Content] Applied ${payload.action} for @${handle} without refetching the list.`)
    return nextCache
}
