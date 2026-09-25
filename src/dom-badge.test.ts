import { describe, expect, it } from 'vitest'
import { BADGE_TARGET_SELECTOR, findHandle, formatListNames, getProfileHandleFromPath } from './dom-badge'

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

    it('uses the profile route when the header handle is not yet linked', () => {
        document.body.innerHTML = '<div data-testid="UserProfileHeader_Items"><span>@thecodinglove</span></div>'
        const header = document.querySelector('[data-testid="UserProfileHeader_Items"]') as HTMLElement

        expect(getProfileHandleFromPath('/thecodinglove')).toBe('thecodinglove')
        expect(findHandle(header, getProfileHandleFromPath('/thecodinglove'))).toMatchObject({ handle: 'thecodinglove' })
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
