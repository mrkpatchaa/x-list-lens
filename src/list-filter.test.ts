import { describe, expect, it } from 'vitest'
import { getUserIdFromTwid, isOwnedListRecord } from './list-filter'

describe('getUserIdFromTwid', () => {
    it('reads the user ID from the encoded twid cookie format', () => {
        expect(getUserIdFromTwid('u%3D200451873%7Ccookie-suffix')).toBe('200451873')
        expect(getUserIdFromTwid('u%3D200451873')).toBe('200451873')
    })
})

describe('isOwnedListRecord', () => {
    it('rejects records explicitly marked as recommendations', () => {
        expect(isOwnedListRecord({ id_str: '1', owned: false }, '42')).toBe(false)
    })

    it('keeps records owned by the signed-in user', () => {
        expect(isOwnedListRecord({ id_str: '1', owner: { rest_id: '42' } }, '42')).toBe(true)
    })

    it('rejects records owned by another user when ownership is explicit', () => {
        expect(isOwnedListRecord({ id_str: '1', owner: { rest_id: '99' } }, '42')).toBe(false)
    })

    it('keeps unknown ownership shapes to avoid dropping valid lists', () => {
        expect(isOwnedListRecord({ id_str: '1', name: 'Design' }, '42')).toBe(true)
        expect(isOwnedListRecord({ id_str: '1' })).toBe(true)
    })
})
