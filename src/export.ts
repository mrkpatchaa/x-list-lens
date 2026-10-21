import type { ListCache, ListMeta } from './shared'

export type ExportList = { id: string; name: string; owned: boolean; memberCount: number; members: string[] }
export type FollowedListsForExport = Record<string, { name: string; included: boolean }>

// Built from the local cache only. Export never calls X.
export function collectExport(cache: ListCache, meta: ListMeta, followed: FollowedListsForExport): ExportList[] {
    const members = new Map<string, string[]>()
    for (const [handle, listIds] of Object.entries(cache)) {
        for (const id of listIds) {
            if (!members.has(id)) members.set(id, [])
            members.get(id)!.push(handle)
        }
    }
    return Object.entries(meta).map(([id, name]) => {
        const handles = (members.get(id) || []).sort((a, b) => a.localeCompare(b))
        return { id, name, owned: !(id in followed), memberCount: handles.length, members: handles }
    })
}

// Quote fields that need it, and stop a spreadsheet from running a value as a
// formula: followed list names are written by other people.
function csvCell(value: string): string {
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(lists: ExportList[]): string {
    const rows = [['list_id', 'list_name', 'handle', 'owned']]
    for (const list of lists) {
        for (const handle of list.members) rows.push([list.id, list.name, handle, String(list.owned)])
    }
    return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export function toJson(lists: ExportList[], exportedAt: Date): string {
    return JSON.stringify({ exportedAt: exportedAt.toISOString(), lists }, null, 2) + '\n'
}

// Uses the local date, so an export just after midnight is named for today.
export function exportFileName(kind: 'csv' | 'json', now: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `listlens-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${kind}`
}
