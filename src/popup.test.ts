import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function installChromeMock(
    queryIds: Record<string, string> = { 'queryId:ListsManagementPageTimeline': 'lists-query' },
    overrides: Record<string, unknown> = {},
) {
    const storage: Record<string, unknown> = {
        listCache: {},
        listMeta: {},
        syncState: { status: 'idle' },
        ...overrides,
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
    beforeEach(async () => {
        vi.resetModules();
        const html = readFileSync('index.html', 'utf8');
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        document.body.innerHTML = parsed.body.innerHTML;
        installChromeMock();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('starts in setup mode when a required query has not been harvested', async () => {
        await import('./popup');
        await vi.waitFor(() => expect(document.getElementById('syncBtn')?.hasAttribute('disabled')).toBe(true));

        expect(document.getElementById('setupNotice')?.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('setupTitle')?.textContent).toBe('Open one of your lists');
        expect(document.getElementById('openListsBtn')?.textContent).toContain('Open Lists on X');
    });

    it('shows list names and filters the list directory', async () => {
        vi.resetModules();
        installChromeMock({
            'queryId:ListsManagementPageTimeline': 'lists-query',
            'queryId:ListMembers': 'members-query',
        }, {
            listCache: { alice: ['1'], bob: ['1', '2'] },
            listMeta: { '1': 'Design', '2': 'Coding' },
        });
        await import('./popup');
        await vi.waitFor(() => expect(document.getElementById('listsList')?.textContent).toContain('Design'));

        const listText = document.getElementById('listsList')?.textContent || '';
        expect(listText).toContain('2 people');
        expect(listText).toContain('1 person');

        const search = document.getElementById('listsSearch') as HTMLInputElement;
        search.value = 'cod';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() => expect(document.getElementById('listsList')?.textContent).toContain('Coding'));
        expect(document.getElementById('listsList')?.textContent).not.toContain('Design');
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
