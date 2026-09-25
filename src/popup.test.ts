import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function installChromeMock(queryIds: Record<string, string> = { 'queryId:ListsManagementPageTimeline': 'lists-query' }) {
    const storage: Record<string, unknown> = {
        listCache: {},
        listMeta: {},
        syncState: { status: 'idle' },
        ...queryIds,
    }

    const chromeMock = {
        storage: {
            local: {
                get: vi.fn(async (keys: string[] | null) => {
                    const requested = keys || Object.keys(storage);
                    return Object.fromEntries(requested.filter((key) => key in storage).map((key) => [key, storage[key]]));
                }),
                set: vi.fn(async (values: Record<string, unknown>) => Object.assign(storage, values)),
            },
            onChanged: { addListener: vi.fn() },
        },
        runtime: {
            sendMessage: vi.fn(async () => ({ status: 'started' })),
        },
        tabs: {
            create: vi.fn(async () => undefined),
        },
    }

    vi.stubGlobal('chrome', chromeMock)
    return chromeMock
}

describe('popup states', () => {
    beforeEach(() => {
        vi.resetModules();
        const html = readFileSync('index.html', 'utf8');
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        document.body.innerHTML = parsed.body.innerHTML;
        installChromeMock();
    });

    it('starts in setup mode when a required query has not been harvested', async () => {
        await import('./popup');
        await vi.waitFor(() => expect(document.getElementById('syncBtn')?.hasAttribute('disabled')).toBe(true));

        expect(document.getElementById('setupNotice')?.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('setupTitle')?.textContent).toBe('Open one of your lists');
        expect(document.getElementById('openListsBtn')?.textContent).toContain('Open Lists on X');
    });

    it('enables syncing after both required queries are present', async () => {
        vi.resetModules();
        installChromeMock({
            'queryId:ListsManagementPageTimeline': 'lists-query',
            'queryId:ListMembers': 'members-query',
        });
        await import('./popup');
        await vi.waitFor(() => expect(document.getElementById('syncBtn')?.hasAttribute('disabled')).toBe(false));

        expect(document.getElementById('setupNotice')?.classList.contains('hidden')).toBe(true);
        expect(document.getElementById('statusBadge')?.textContent).toBe('Ready');
    });
});
