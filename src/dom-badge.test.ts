import { describe, expect, it } from 'vitest'
import { BADGE_TARGET_SELECTOR, findHandle, findHandleForUserId, formatListNames, getProfileHandleFromPath } from './dom-badge'

describe('badge target selection', () => {
    it('includes the profile header used above the feed', () => {
        document.body.innerHTML = '<div data-testid="UserProfileHeader_Items"><a href="/alice"><span>@alice</span></a></div>'

        const header = document.querySelector(BADGE_TARGET_SELECTOR) as HTMLElement
        expect(header).not.toBeNull()
        expect(findHandle(header)?.handle).toBe('alice')
    })
})

describe('findHandle', () => {
    it('accepts a canonical X profile link and ignores display-name text', () => {
        document.body.innerHTML = `
            <div data-testid="UserName">
                <div data-testid="User-Name">
                    <span>@not-the-handle</span>
                    <a href="/alice"><span>@Alice</span></a>
                </div>
            </div>
        `

        expect(findHandle(document.querySelector('[data-testid="UserName"]') as HTMLElement))
            .toMatchObject({ handle: 'alice' })
    })

    it('rejects an unlinked handle until the profile link is rendered', () => {
        document.body.innerHTML = '<div data-testid="UserName"><span>@alice</span></div>'
        expect(findHandle(document.querySelector('[data-testid="UserName"]') as HTMLElement)).toBeNull()
    })

    it('uses the profile route when the UserName block is not linked', () => {
        document.body.innerHTML = '<div data-testid="UserName"><span>@thecodinglove</span></div>'
        const name = document.querySelector('[data-testid="UserName"]') as HTMLElement

        expect(getProfileHandleFromPath('/thecodinglove')).toBe('thecodinglove')
        expect(findHandle(name, getProfileHandleFromPath('/thecodinglove'))).toMatchObject({ handle: 'thecodinglove' })
    })

    it('rejects a linked route that is not a profile handle', () => {
        document.body.innerHTML = '<div data-testid="UserName"><a href="/i/lists"><span>@alice</span></a></div>'
        expect(findHandle(document.querySelector('[data-testid="UserName"]') as HTMLElement)).toBeNull()
    })
})

describe('formatListNames', () => {
    it('uses display names and falls back safely to IDs', () => {
        expect(formatListNames(['1', '2'], { '1': 'Design' })).toBe('Design, 2')
    })
})

describe('findHandleForUserId', () => {
    it('reads the handle from the follow button that carries the user ID', () => {
        document.body.innerHTML = `
            <button data-testid="98808847-follow" aria-label="Follow @someone_else"></button>
            <button data-testid="10141756581996134400-follow" aria-label="Follow @longer_id"></button>
            <button data-testid="1014175658199613440-unfollow" aria-label="Following @SantoshYadavDev"></button>`

        expect(findHandleForUserId(document, '1014175658199613440')).toBe('santoshyadavdev')
        expect(findHandleForUserId(document, '42')).toBeUndefined()
    })
})
