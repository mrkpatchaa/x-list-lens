import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    MSG,
    getMissingOperations,
    getStoredQueryIds,
    isListMutationMessage,
    isQueryHarvestedMessage,
    isValidListId,
    isValidQueryId,
} from './shared'

describe('page message validation', () => {
    it('accepts an allowlisted harvested query', () => {
        expect(isQueryHarvestedMessage({
            type: MSG.QUERY_HARVESTED,
            payload: { operationName: 'ListMembers', queryId: 'abc123_-' },
        })).toBe(true)
    })

    it('rejects unknown operations and malformed query IDs', () => {
        expect(isQueryHarvestedMessage({
            type: MSG.QUERY_HARVESTED,
            payload: { operationName: 'DeleteEverything', queryId: 'abc123' },
        })).toBe(false)
        expect(isQueryHarvestedMessage({
            type: MSG.QUERY_HARVESTED,
            payload: { operationName: 'ListMembers', queryId: '../other/path' },
        })).toBe(false)
    })

    it('accepts only bounded numeric list mutations', () => {
        expect(isListMutationMessage({
            type: MSG.LIST_MUTATION,
            payload: { listId: '123', userId: '456', action: 'add' },
        })).toBe(true)
        expect(isListMutationMessage({
            type: MSG.LIST_MUTATION,
            payload: { listId: '../../bad', userId: '456', action: 'add' },
        })).toBe(false)
    })
})

describe('setup state', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('falls back to query IDs stored by the original extension', async () => {
        vi.stubGlobal('chrome', {
            storage: {
                local: {
                    get: vi.fn(async () => ({
                        queryIds: {
                            ListsManagementPageTimeline: 'legacy-lists',
                            ListMembers: 'legacy-members',
                        },
                    })),
                },
            },
        })

        await expect(getStoredQueryIds()).resolves.toEqual({
            ListsManagementPageTimeline: 'legacy-lists',
            ListMembers: 'legacy-members',
        })
    })

    it('reports the exact missing operations in order', () => {
        expect(getMissingOperations({ ListMembers: 'abc123' }))
            .toEqual(['ListsManagementPageTimeline'])
        expect(getMissingOperations({})).toEqual([
            'ListsManagementPageTimeline',
            'ListMembers',
        ])
    })
})

describe('ID validation', () => {
    it('rejects path-like IDs', () => {
        expect(isValidQueryId('safe-id_123')).toBe(true)
        expect(isValidQueryId('../redirect')).toBe(false)
        expect(isValidListId('123456789')).toBe(true)
        expect(isValidListId('12/34')).toBe(false)
    })
})
