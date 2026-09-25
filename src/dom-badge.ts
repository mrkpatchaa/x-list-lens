export type FoundHandle = {
    handle: string;
    span: HTMLSpanElement;
    link: HTMLAnchorElement;
}

const HANDLE_RE = /^@[A-Za-z0-9_]{1,15}$/;

function profileHandleFromHref(href: string | null): string | undefined {
    if (!href) return undefined;
    try {
        const path = new URL(href, 'https://x.com').pathname.split('/').filter(Boolean)[0];
        if (!path) return undefined;
        const decoded = decodeURIComponent(path).toLowerCase();
        return /^[a-z0-9_]{1,15}$/.test(decoded) ? decoded : undefined;
    } catch {
        return undefined;
    }
}

export function findHandle(node: HTMLElement): FoundHandle | null {
    const scope = node.matches('[data-testid="User-Name"]')
        ? node
        : node.querySelector('[data-testid="User-Name"]') || node;

    for (const span of Array.from(scope.querySelectorAll('span'))) {
        const text = span.textContent?.trim();
        if (!text || !HANDLE_RE.test(text)) continue;

        const link = span.closest('a');
        const linkedHandle = profileHandleFromHref(link?.getAttribute('href') || null);
        const handle = text.slice(1).toLowerCase();
        if (!link || linkedHandle !== handle) continue;

        return { handle, span, link };
    }

    return null;
}

export function formatListNames(listIds: string[], listMeta: Record<string, string>): string {
    return listIds.map((id) => listMeta[id] || id).join(', ');
}
