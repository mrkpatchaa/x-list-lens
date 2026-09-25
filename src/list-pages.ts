import type { OwnedListSummary } from './list-ownership'

export type ListPage = {
    lists: OwnedListSummary[]
    cursor: string
}

export async function collectListPages(
    loadPage: (cursor: string) => Promise<ListPage>,
    maxPages = 1,
): Promise<OwnedListSummary[]> {
    const lists = new Map<string, OwnedListSummary>()
    const seenCursors = new Set<string>()
    let cursor = ''
    const pageLimit = Math.max(1, Math.floor(maxPages))

    for (let page = 0; page < pageLimit; page++) {
        const result = await loadPage(cursor)
        for (const list of result.lists) lists.set(list.id, list)

        if (!result.cursor || result.cursor === cursor || seenCursors.has(result.cursor)) break
        seenCursors.add(result.cursor)
        cursor = result.cursor
    }

    return [...lists.values()]
}
