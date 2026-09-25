import { XApiError } from './x-api'
import { isOwnedListRecord } from './list-filter'

export type OwnedListSummary = { id: string; name: string }

type JsonRecord = Record<string, unknown>

const MAX_TRAVERSAL_NODES = 50_000
const LIST_ID_RE = /^\d{1,32}$/

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readListRecord(value: unknown): OwnedListSummary | undefined {
    if (!isRecord(value)) return undefined

    const id = readString(value.id_str)
    const name = readString(value.name)
    if (!id || !name || !LIST_ID_RE.test(id) || name.length > 200) return undefined
    if (value.member_count === undefined && value.mode === undefined) return undefined

    return { id, name }
}

function isOwnershipKey(key: string): boolean {
    const normalized = key.toLowerCase().replace(/[-_]/g, '')
    return normalized === 'ownedlists'
        || normalized === 'listownerships'
        || normalized === 'listownership'
        || normalized === 'ownerships'
}

function readCursor(value: unknown): string | undefined {
    const cursor = readString(value)
    return cursor && cursor !== '0' ? cursor : undefined
}

export function parseOwnedListsPage(
    payload: unknown,
    currentUserId: string,
): { lists: OwnedListSummary[]; cursor: string } {
    if (!isRecord(payload) || !isRecord(payload.data)) {
        if (isRecord(payload) && Array.isArray(payload.errors) && payload.errors.length > 0) {
            throw new XApiError('X rejected the ListOwnerships request.', 'graphql', 'ListOwnerships')
        }
        throw new XApiError(
            'The ListOwnerships response could not be read. X may have changed it.',
            'contract',
            'ListOwnerships',
        )
    }

    const lists = new Map<string, OwnedListSummary>()
    let cursor = ''
    let foundOwnershipConnection = false
    let listRecordCount = 0
    let ownedListRecordCount = 0
    let visited = 0
    const queue: Array<{ value: unknown; underOwnership: boolean; depth: number }> = [
        { value: payload.data, underOwnership: false, depth: 0 },
    ]

    for (let index = 0; index < queue.length && visited < MAX_TRAVERSAL_NODES; index++) {
        const current = queue[index]
        visited++
        if (current.depth > 16) continue

        if (Array.isArray(current.value)) {
            for (const item of current.value) {
                queue.push({ value: item, underOwnership: current.underOwnership, depth: current.depth + 1 })
            }
            continue
        }
        if (!isRecord(current.value)) continue

        if (current.underOwnership) {
            const record = readListRecord(current.value)
            if (record) {
                listRecordCount++
                if (isOwnedListRecord(current.value, currentUserId, true)) {
                    lists.set(record.id, record)
                    ownedListRecordCount++
                }
            }
        }

        for (const [key, child] of Object.entries(current.value)) {
            const ownershipKey = isOwnershipKey(key)
            const underOwnership = current.underOwnership || ownershipKey
            if (ownershipKey) foundOwnershipConnection = true

            const normalizedKey = key.toLowerCase().replace(/[-_]/g, '')
            if (underOwnership && (normalizedKey === 'cursor' || normalizedKey === 'nextcursor' || normalizedKey === 'endcursor')) {
                cursor = readCursor(child) || cursor
            }

            if (isRecord(child) || Array.isArray(child)) {
                queue.push({ value: child, underOwnership, depth: current.depth + 1 })
            }
        }
    }

    if (!foundOwnershipConnection) {
        throw new XApiError(
            'The ListOwnerships response had no ownership connection. X may have changed it.',
            'contract',
            'ListOwnerships',
        )
    }
    if (listRecordCount > 0 && ownedListRecordCount === 0) {
        throw new XApiError(
            'The ListOwnerships response contained no lists owned by the signed-in user.',
            'contract',
            'ListOwnerships',
        )
    }

    return { lists: [...lists.values()], cursor }
}
