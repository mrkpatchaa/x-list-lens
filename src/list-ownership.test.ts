import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildListOwnershipsVariables, parseListManagementPage, parseOwnedListsPage } from './list-ownership'

const listRecord = (id: string, name: string, ownerId = '42') => ({
    id_str: id,
    name,
    member_count: 2,
    mode: 'Public',
    owner_id_str: ownerId,
})

const ownershipPayload = (results: unknown[], cursor = '') => ({
    data: {
        user: {
            result: {
                owned_lists: {
                    ...(cursor ? { cursor } : {}),
                    results,
                },
            },
        },
    },
})

describe('ListOwnerships request', () => {
    it('includes both ownership variables used by X and the requested cursor', () => {
        expect(JSON.parse(buildListOwnershipsVariables('42', 100))).toEqual({
            userId: '42',
            isListMemberTargetUserId: '42',
            count: 100,
        })
        expect(JSON.parse(buildListOwnershipsVariables('42', 100, 'NEXT_PAGE'))).toMatchObject({
            cursor: 'NEXT_PAGE',
        })
    })
})

const timelineOwnershipPayload = (entries: unknown[]) => ({
    data: {
        user: {
            result: {
                timeline: {
                    timeline: {
                        instructions: [
                            { type: 'TimelineAddEntries', entries },
                        ],
                    },
                },
            },
        },
    },
})

const managementPayload = (entries: unknown[]) => ({
    data: {
        list_management: {
            timeline: {
                timeline: {
                    instructions: [
                        { type: 'TimelineAddEntries', entries },
                    ],
                },
            },
        },
    },
})

describe('parseOwnedListsPage', () => {
    it('filters nested owners from the combined management response', () => {
        expect(parseListManagementPage(managementPayload([
            {
                entryId: 'list-1',
                content: {
                    itemContent: {
                        list: {
                            id_str: '1',
                            name: 'Mine',
                            member_count: 2,
                            user_results: { result: { rest_id: '42' } },
                        },
                    },
                },
            },
            {
                entryId: 'list-2',
                content: {
                    itemContent: {
                        list: {
                            id_str: '2',
                            name: 'Recommendation',
                            member_count: 3,
                            user_results: { result: { rest_id: '99' } },
                        },
                    },
                },
            },
        ]), '42')).toEqual({
            lists: [{ id: '1', name: 'Mine', memberCount: 2 }],
            followed: [],
            cursor: '',
        })
    })

    it('keeps only lists owned by the current user and exposes the cursor', () => {
        expect(parseOwnedListsPage(ownershipPayload([
            listRecord('1', 'Mine'),
            listRecord('2', 'Recommendation', '99'),
            listRecord('1', 'Mine'),
        ], 'NEXT_PAGE'), '42')).toEqual({
            lists: [{ id: '1', name: 'Mine', memberCount: 2 }],
            followed: [],
            cursor: 'NEXT_PAGE',
        })
    })

    it('accepts ownership timeline list objects that only expose membership metadata', () => {
        expect(parseOwnedListsPage(timelineOwnershipPayload([
            {
                entryId: 'list-1',
                content: {
                    itemContent: {
                        list: { id_str: '1', name: 'Mine', is_member: true },
                    },
                },
            },
        ]), '42')).toEqual({
            lists: [{ id: '1', name: 'Mine' }],
            followed: [],
            cursor: '',
        })
    })

    it('accepts list metadata variants used by the management response', () => {
        expect(parseListManagementPage(managementPayload([
            {
                entryId: 'list-1',
                content: {
                    itemContent: {
                        list: {
                            rest_id: '1',
                            name: 'Mine',
                            subscriber_count: 4,
                            user_results: { result: { rest_id: '42' } },
                        },
                    },
                },
            },
        ]), '42')).toEqual({
            lists: [{ id: '1', name: 'Mine' }],
            followed: [],
            cursor: '',
        })
    })

    it('parses the timeline shape used by some X ownership responses', () => {
        expect(parseOwnedListsPage(timelineOwnershipPayload([
            {
                entryId: 'list-1',
                content: {
                    itemContent: {
                        list_results: { result: listRecord('1', 'Mine') },
                    },
                },
            },
            {
                entryId: 'cursor-bottom-1',
                content: { value: 'NEXT_PAGE' },
            },
        ]), '42')).toEqual({
            lists: [{ id: '1', name: 'Mine', memberCount: 2 }],
            followed: [],
            cursor: 'NEXT_PAGE',
        })
    })

    it('accepts a valid empty timeline response', () => {
        expect(parseOwnedListsPage(timelineOwnershipPayload([]), '42')).toEqual({
            lists: [],
            followed: [],
            cursor: '',
        })
    })

    it('fails closed when every returned list belongs to another user', () => {
        expect(() => parseOwnedListsPage(ownershipPayload([
            listRecord('2', 'Recommendation', '99'),
        ]), '42')).toThrow(/owned/i)
    })

    it('accepts a valid empty ownership result', () => {
        expect(parseOwnedListsPage(ownershipPayload([]), '42')).toEqual({
            lists: [],
            followed: [],
            cursor: '',
        })
    })

    it('rejects a response that has no ownership connection', () => {
        expect(() => parseOwnedListsPage({ data: { unexpected: true } }, '42'))
            .toThrow(/ownership/i)
    })

    it('rejects GraphQL errors without usable data', () => {
        expect(() => parseOwnedListsPage({ errors: [{ message: 'Unknown query' }] }, '42'))
            .toThrow(/ListOwnerships/)
    })
})

const capture = JSON.parse(readFileSync('src/fixtures/lists-management-timeline.json', 'utf8'))

describe('real ListsManagementPageTimeline capture', () => {
    it('reads owned lists and member counts from a real capture', () => {
        const { lists } = parseListManagementPage(capture, '1000')
        expect(lists.map((l) => [l.id, l.memberCount])).toEqual([['3001', 14], ['3002', 15], ['3003', 96], ['3004', 49]])
        expect(lists.every((l) => l.ownerHandle === 'listlens_owner')).toBe(true)
    })

    it('separates owned, followed and recommended lists in a real capture', () => {
        const page = parseListManagementPage(capture, '1000')
        // Owned lists carry following: true too, and must stay owned.
        expect(page.lists.map((l) => l.id)).toEqual(['3001', '3002', '3003', '3004'])
        // 4001 and 4002 are recommendations; 5001 is the synthetic followed list.
        expect(page.followed.map((l) => [l.id, l.name, l.memberCount])).toEqual([['5001', 'Followed demo', 7]])
    })

    it('reads the followed lists of a user who owns none', () => {
        const page = parseListManagementPage(capture, '9999')
        expect(page.lists).toEqual([])
        expect(page.followed.map((l) => l.id)).toEqual(['3001', '3002', '3003', '3004', '5001'])
    })
})
