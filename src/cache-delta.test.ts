import { describe, expect, it } from 'vitest'
import { applyMembershipDelta } from './cache-delta'

describe('applyMembershipDelta', () => {
    it('adds a newly seen account without rebuilding other memberships', () => {
        expect(applyMembershipDelta({ alice: ['1'] }, '2', 'Bob', 'add')).toEqual({
            alice: ['1'],
            bob: ['2'],
        })
    })

    it('removes only the affected list membership', () => {
        expect(applyMembershipDelta({ alice: ['1', '2'], bob: ['2'] }, '2', 'alice', 'remove')).toEqual({
            alice: ['1'],
        })
    })

    it('does not mutate the previous cache', () => {
        const cache = { alice: ['1'] }
        applyMembershipDelta(cache, '1', 'alice', 'remove')
        expect(cache).toEqual({ alice: ['1'] })
    })
})
