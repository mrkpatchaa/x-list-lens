export type FoundHandle = {
    handle: string;
    span: HTMLSpanElement;
    link: HTMLAnchorElement | null;
}

export const BADGE_TARGET_SELECTOR = '[data-testid="tweet"], [data-testid="UserName"], [data-testid="UserCell"], [data-testid="UserProfileHeader_Items"]';
export const PROFILE_HEADER_SELECTOR = '[data-testid="UserProfileHeader_Items"]';

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

export function getProfileHandleFromPath(pathname: string): string | undefined {
    const match = pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
    return match?.[1]?.toLowerCase();
}

export function findHandle(node: HTMLElement, fallbackHandle?: string): FoundHandle | null {
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

    if (fallbackHandle) {
        const fallbackText = `@${fallbackHandle}`;
        const fallbackSpan = Array.from(scope.querySelectorAll('span')).find((span) => span.textContent?.trim() === fallbackText);
        if (fallbackSpan) {
            const link = fallbackSpan.closest('a');
            return {
                handle: fallbackHandle,
                span: fallbackSpan,
                link: link && profileHandleFromHref(link.getAttribute('href')) === fallbackHandle ? link : null,
            };
        }
    }

    return null;
}

export function formatListNames(listIds: string[], listMeta: Record<string, string>): string {
    return listIds.map((id) => listMeta[id] || id).join(', ');
}
