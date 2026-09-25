import { describe, expect, it } from 'vitest'
import {
    XApiError,
    parseListsPage,
    parseMembersPage,
    replaceListMembership,
} from './x-api'

const memberEntry = (handle: string, id = handle) => ({
    entryId: `tweet-${id}`,
    content: {
        itemContent: {
            user_results: {
                result: {
                    core: { screen_name: handle },
                    legacy: { screen_name: handle.toUpperCase() },
                },
            },
        },
    },
})

const cursorEntry = (cursor: string) => ({
    entryId: 'cursor-bottom-1',
    content: { value: cursor },
})

const memberPayload = (entries: unknown[]) => ({
    data: {
        list: {
            members_timeline: {
                timeline: {
                    instructions: [
                        { type: 'TimelineClearCache' },
                        { type: 'TimelineAddEntries', entries },
                    ],
                },
            },
        },
    },
})

const listRecord = (id: string, name: string) => ({
    id_str: id,
    name,
    member_count: 3,
    mode: 'Public',
})

const listPayload = (entries: unknown[]) => ({
    data: {
        list_management: {
            timeline: {
                instructions: [{ type: 'TimelineAddEntries', entries }],
            },
        },
    },
})

describe('parseMembersPage', () => {
    it('parses current and legacy member handles without duplicate records', () => {
        const page = parseMembersPage(memberPayload([
            memberEntry('alice', '1'),
            memberEntry('bob', '2'),
            cursorEntry('NEXT_PAGE'),
        ]))

        expect(page.handles).toEqual(['alice', 'bob'])
        expect(page.cursor).toBe('NEXT_PAGE')
    })

    it('supports legacy member result wrappers', () => {
        const page = parseMembersPage(memberPayload([{
            entryId: 'member-1',
            content: {
                itemContent: {
                    user: { screen_name: 'Alice' },
                },
            },
        }]))

        expect(page.handles).toEqual(['alice'])
    })

    it('rejects GraphQL errors instead of treating them as an empty list', () => {
        expect(() => parseMembersPage({ errors: [{ message: 'Unknown query' }] }))
            .toThrow(XApiError)
    })

    it('keeps usable member data when X returns partial GraphQL errors', () => {
        const payload = {
            ...memberPayload([memberEntry('alice')]),
            errors: [{ message: 'Unavailable member' }],
        }

        expect(parseMembersPage(payload).handles).toEqual(['alice'])
    })

    it('fails closed when the expected member timeline is missing', () => {
        const unsafePayload = {
            data: {
                list: {
                    owner: { legacy: { screen_name: 'list-owner' } },
                    quoted_user: { legacy: { screen_name: 'quoted-user' } },
                },
            },
        }

        expect(() => parseMembersPage(unsafePayload)).toThrow(/could not be read/i)
    })
})

describe('parseListsPage', () => {
    it('deduplicates list records and returns the next cursor', () => {
        const page = parseListsPage(listPayload([
            { entryId: 'list-1', content: { itemContent: { list_results: { result: listRecord('1', 'Design') } } } },
            { entryId: 'cursor-bottom-1', content: { value: 'NEXT_LISTS' } },
            { entryId: 'list-1-reference', content: { itemContent: { list_results: { result: listRecord('1', 'Design') } } } },
        ]))

        expect(page.lists).toEqual([{ id: '1', name: 'Design' }])
        expect(page.cursor).toBe('NEXT_LISTS')
    })

    it('ignores embedded owners that are not list results', () => {
        const page = parseListsPage(listPayload([{
            entryId: 'list-1',
            content: {
                itemContent: {
                    list_results: { result: listRecord('1', 'Design') },
                    user: { id_str: '999', name: 'Owner', screen_name: 'owner', member_count: 2, mode: 'Public' },
                },
            },
        }]))

        expect(page.lists).toEqual([{ id: '1', name: 'Design' }])
    })

    it('supports list records nested under a list-specific wrapper', () => {
        const page = parseListsPage(listPayload([{
            entryId: 'list-1',
            content: {
                itemContent: {
                    list_management: {
                        result: { ...listRecord('1', 'Design'), member_count: 4 },
                    },
                },
            },
        }]))

        expect(page.lists).toEqual([{ id: '1', name: 'Design' }])
    })

    it('falls back to the known legacy list shape when wrappers change', () => {
        const page = parseListsPage(listPayload([{
            entryId: 'list-1',
            content: {
                itemContent: {
                    unexpected_wrapper: { value: listRecord('1', 'Design') },
                },
            },
        }]))

        expect(page.lists).toEqual([{ id: '1', name: 'Design' }])
    })

    it('finds legacy list records outside timeline entries', () => {
        const payload = listPayload([cursorEntry('END')]) as {
            data: { legacy_list: ReturnType<typeof listRecord> }
        }
        payload.data.legacy_list = listRecord('1', 'Design')

        expect(parseListsPage(payload).lists).toEqual([{ id: '1', name: 'Design' }])
    })

    it('accepts a validated timeline with no lists', () => {
        expect(parseListsPage(listPayload([cursorEntry('END')]))).toEqual({ lists: [], cursor: 'END' })
    })

    it('rejects payloads without a list timeline', () => {
        expect(() => parseListsPage({ data: {} })).toThrow(XApiError)
    })
})

describe('replaceListMembership', () => {
    it('replaces one list without changing other memberships', () => {
        const cache = {
            alice: ['1', '2'],
            bob: ['1'],
            carol: ['3'],
        }

        const next = replaceListMembership(cache, '2', new Set(['Alice', 'dave']))

        expect(next).toEqual({
            alice: ['1', '2'],
            bob: ['1'],
            carol: ['3'],
            dave: ['2'],
        })
    })

    it('does not mutate the previous cache', () => {
        const cache = { alice: ['1'] }
        replaceListMembership(cache, '1', new Set())
        expect(cache).toEqual({ alice: ['1'] })
    })
})
