import { collectExport, exportFileName, toCsv, toJson, type FollowedListsForExport } from './export'
import { getLocal, type ListCache, type ListMeta } from './shared'

export type ExportFormat = 'csv' | 'json'

export async function buildExportFile(format: ExportFormat): Promise<{ name: string; blob: Blob }> {
    const stored = await getLocal(['listCache', 'listMeta', 'followedLists'])
    const lists = collectExport(
        (stored.listCache || {}) as ListCache,
        (stored.listMeta || {}) as ListMeta,
        (stored.followedLists || {}) as FollowedListsForExport,
    )
    const now = new Date()
    return format === 'csv'
        ? { name: exportFileName('csv', now), blob: new Blob([toCsv(lists)], { type: 'text/csv;charset=utf-8' }) }
        : { name: exportFileName('json', now), blob: new Blob([toJson(lists, now)], { type: 'application/json' }) }
}

// Returns the link, so a page can also show it for a manual click.
export function downloadBlob(name: string, blob: Blob): HTMLAnchorElement {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = name
    link.textContent = `Download ${name}`
    link.click()
    return link
}

// The popup downloads at once and needs no visible link afterwards.
export function downloadAndRelease(name: string, blob: Blob): void {
    const link = downloadBlob(name, blob)
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000)
}

// Safari's popup closes before a download starts and Safari has no downloads
// API, so Safari downloads from a full extension tab instead.
export function needsExportTab(userAgent = navigator.userAgent): boolean {
    return /Safari\//.test(userAgent) && !/(Chrome|Chromium|CriOS|OPR|Edg)\//.test(userAgent)
}
