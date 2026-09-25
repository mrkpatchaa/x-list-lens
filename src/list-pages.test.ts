import { describe, expect, it } from 'vitest'
import { collectListPages } from './list-pages'

describe('collectListPages', () => {
    it('does not follow an endless stream of cursors by default', async () => {
        let calls = 0
        const lists = await collectListPages(async () => {
            calls++
            return { lists: [], cursor: `cursor-${calls}` }
        })

        expect(calls).toBe(1)
        expect(lists).toEqual([])
    })

    it('deduplicates records when a bounded second page is requested', async () => {
        const lists = await collectListPages(async (cursor) => ({
            lists: cursor ? [{ id: '1', name: 'Mine' }] : [{ id: '1', name: 'Mine' }],
            cursor: cursor ? '' : 'NEXT',
        }), 2)

        expect(lists).toEqual([{ id: '1', name: 'Mine' }])
    })
})
