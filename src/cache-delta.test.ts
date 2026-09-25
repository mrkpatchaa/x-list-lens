import { describe, expect, it } from 'vitest'
import { applyMembershipDelta } from './cache-delta'

describe('applyMembershipDelta', () => {
    it('adds a newly seen account without rebuilding other memberships', () => {
        expect(applyMembershipDelta({ alice: ['1'] }, '2', 'Bob', 'add')).toEqual({
            alice: ['1'],
            bob: ['2'],
        })
    })

    it('removes only the targeted account from the affected list', () => {
        expect(applyMembershipDelta({
            alice: ['1', '2'],
            bob: ['1', '2'],
            carol: ['1'],
        }, '2', 'alice', 'remove')).toEqual({
            alice: ['1'],
            bob: ['1', '2'],
            carol: ['1'],
        })
    })

    it('does not mutate an existing account list when adding', () => {
        const cache = { alice: ['1'] }
        expect(applyMembershipDelta(cache, '2', 'alice', 'add')).toEqual({ alice: ['1', '2'] })
        expect(cache).toEqual({ alice: ['1'] })
    })

    it('does not mutate the previous cache', () => {
        const cache = { alice: ['1'] }
        applyMembershipDelta(cache, '1', 'alice', 'remove')
        expect(cache).toEqual({ alice: ['1'] })
    })
})
