import { describe, expect, it } from 'vitest'
import { hasTimelineInstructions } from './list-response'

describe('hasTimelineInstructions', () => {
    it('accepts a valid empty list timeline', () => {
        expect(hasTimelineInstructions({ data: { list_management: { timeline: { instructions: [] } } } })).toBe(true)
    })

    it('rejects responses without a timeline shape', () => {
        expect(hasTimelineInstructions({ data: { unexpected: true } })).toBe(false)
    })
})
