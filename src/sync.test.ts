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
})
