import { describe, expect, it } from 'vitest'
import { BADGE_TARGET_SELECTOR, findHandle, formatListNames } from './dom-badge'

describe('badge target selection', () => {
    it('includes the profile header used above the feed', () => {
        document.body.innerHTML = '<div data-testid="UserProfileHeader_Items"><a href="/alice"><span>@alice</span></a></div>'

        expect(document.querySelector(BADGE_TARGET_SELECTOR)).not.toBeNull()
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
