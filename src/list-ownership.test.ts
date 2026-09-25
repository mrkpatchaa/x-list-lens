import { describe, expect, it } from 'vitest'
import { buildListOwnershipsVariables, parseOwnedListsPage } from './list-ownership'

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

describe('parseOwnedListsPage', () => {
    it('keeps only lists owned by the current user and exposes the cursor', () => {
        expect(parseOwnedListsPage(ownershipPayload([
            listRecord('1', 'Mine'),
            listRecord('2', 'Recommendation', '99'),
            listRecord('1', 'Mine'),
        ], 'NEXT_PAGE'), '42')).toEqual({
            lists: [{ id: '1', name: 'Mine' }],
            cursor: 'NEXT_PAGE',
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
