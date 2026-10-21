import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runSync, type SyncDeps } from './sync'

const capture = () => JSON.parse(readFileSync('src/fixtures/lists-management-timeline.json', 'utf8'))

let storage: Record<string, unknown> = {}

function installStorage(initial: Record<string, unknown> = {}) {
    storage = { ...initial }
    vi.stubGlobal('chrome', {
        storage: {
            local: {
                get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in storage).map((k) => [k, storage[k]]))),
                set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(storage, values) }),
            },
        },
    })
}

// One member page per list: a member unique to the list, plus one shared by all.
function membersPage(listId: string) {
    const user = (id: string, handle: string) => ({
        entryId: `user-${id}`,
        content: { itemContent: { user_results: { result: { rest_id: id, core: { screen_name: handle } } } } },
    })
    return {
        data: { list: { members_timeline: { timeline: { instructions: [
            { type: 'TimelineAddEntries', entries: [user(`9${listId}`, `Member_${listId}`), user('77', 'Shared')] },
        ] } } } },
    }
}

function fakeX(listsPayload: unknown = capture()) {
    const urls: string[] = []
    const fetchJson = vi.fn(async (url: string) => {
        urls.push(url)
        if (url.includes('/ListsManagementPageTimeline')) return listsPayload
        const variables = JSON.parse(new URL(url).searchParams.get('variables') || '{}')
        return membersPage(variables.listId)
    })
    return { urls, fetchJson }
}

function deps(fetchJson: SyncDeps['fetchJson']): SyncDeps {
    return {
        fetchJson,
        delay: async () => {},
        currentUserId: '1000',
        queryIds: { lists: 'lists-q', members: 'members-q' },
        isCancelled: () => false,
        signal: new AbortController().signal,
    }
}

function ownedItems(payload: any): any[] {
    return payload.data.viewer.list_management_timeline.timeline.instructions[3].entries[1].content.items
}

function memberListIds(urls: string[]): string[] {
    return urls
        .filter((url) => url.includes('/ListMembers'))
        .map((url) => JSON.parse(new URL(url).searchParams.get('variables') || '{}').listId)
}

async function afterFullSync() {
    await runSync('full', deps(fakeX().fetchJson))
}

describe('runSync', () => {
    beforeEach(() => installStorage())

    it('full sync reads every list and records counts', async () => {
        const { fetchJson } = fakeX()
        await expect(runSync('full', deps(fetchJson))).resolves.toBe('done')

        expect(storage.listCounts).toEqual({ '3001': 14, '3002': 15, '3003': 96, '3004': 49 })
        expect(typeof storage.lastFullSync).toBe('number')
        expect(storage.selfHandle).toBe('listlens_owner')
        expect(storage.listCache).toEqual({
            member_3001: ['3001'],
            member_3002: ['3002'],
            member_3003: ['3003'],
            member_3004: ['3004'],
            shared: ['3001', '3002', '3003', '3004'],
        })
        expect(storage.syncState).toMatchObject({ status: 'done', mode: 'full', listCount: 4 })
    })

    it('fast sync with no changed list sends only list requests', async () => {
        await afterFullSync()
        const before = storage.listCache
        const { urls, fetchJson } = fakeX()
        await runSync('fast', deps(fetchJson))

        expect(urls.length).toBeGreaterThan(0)
        expect(urls.every((url) => url.includes('/ListsManagementPageTimeline'))).toBe(true)
        expect(storage.listCache).toEqual(before)
        expect(storage.syncState).toMatchObject({ status: 'done', mode: 'fast', changedCount: 0, listCount: 4 })
    })

    it('fast sync re-reads changed and new lists and drops deleted ones', async () => {
        await afterFullSync()
        const fullSyncAt = storage.lastFullSync
        const payload = capture()
        const items = ownedItems(payload)
        items[1].item.itemContent.list.member_count = 16 // 3002 changed
        const added = structuredClone(items[0])
        Object.assign(added.item.itemContent.list, { id_str: '3005', name: 'New', member_count: 3 })
        items.splice(3, 1, added) // 3004 deleted, 3005 new
        const { urls, fetchJson } = fakeX(payload)
        await runSync('fast', deps(fetchJson))

        expect(memberListIds(urls).sort()).toEqual(['3002', '3005'])
        const cache = storage.listCache as Record<string, string[]>
        expect(cache.member_3004).toBeUndefined()
        expect(cache.member_3001).toEqual(['3001'])
        expect(cache.member_3005).toEqual(['3005'])
        expect([...cache.shared].sort()).toEqual(['3001', '3002', '3003', '3005'])
        expect(storage.listMeta).not.toHaveProperty('3004')
        expect(storage.listCounts).toEqual({ '3001': 14, '3002': 16, '3003': 96, '3005': 3 })
        expect(storage.syncState).toMatchObject({ status: 'done', mode: 'fast', changedCount: 3 })
        expect(storage.lastFullSync).toBe(fullSyncAt)
    })

    it('fast sync re-reads a list whose count is missing', async () => {
        await afterFullSync()
        const payload = capture()
        delete ownedItems(payload)[0].item.itemContent.list.member_count
        const { urls, fetchJson } = fakeX(payload)
        await runSync('fast', deps(fetchJson))

        expect(memberListIds(urls)).toEqual(['3001'])
    })

    it('fast sync runs as a full sync when no full sync exists yet', async () => {
        const { urls, fetchJson } = fakeX()
        await runSync('fast', deps(fetchJson))

        expect(memberListIds(urls).sort()).toEqual(['3001', '3002', '3003', '3004'])
        expect(storage.syncState).toMatchObject({ status: 'done', mode: 'full' })
    })

    it('drops the color of a list deleted on X', async () => {
        await afterFullSync()
        storage.listColors = { '3004': 2, '3001': 0 }
        const payload = capture()
        ownedItems(payload).splice(3, 1) // 3004 deleted
        await runSync('fast', deps(fakeX(payload).fetchJson))

        expect(storage.listColors).toEqual({ '3001': 0 })
    })
})
