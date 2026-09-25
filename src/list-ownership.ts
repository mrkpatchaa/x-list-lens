import { XApiError } from './x-api'
import { isOwnedListRecord } from './list-filter'

export type OwnedListSummary = { id: string; name: string }

type JsonRecord = Record<string, unknown>

const MAX_TRAVERSAL_NODES = 50_000
const LIST_ID_RE = /^\d{1,32}$/

export function buildListOwnershipsVariables(
    userId: string,
    count: number,
    cursor?: string,
): string {
    return JSON.stringify({
        userId,
        isListMemberTargetUserId: userId,
        count,
        ...(cursor ? { cursor } : {}),
    })
}

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readListRecord(value: unknown): OwnedListSummary | undefined {
    if (!isRecord(value)) return undefined

    const id = readString(value.id_str) ?? readString(value.rest_id) ?? readString(value.id)
    const name = readString(value.name)
    if (!id || !name || !LIST_ID_RE.test(id) || name.length > 200) return undefined
    const hasListMetadata = value.member_count !== undefined
        || value.mode !== undefined
        || value.subscriber_count !== undefined
        || Object.prototype.hasOwnProperty.call(value, 'is_member')
    if (!hasListMetadata) return undefined

    return { id, name }
}

function isOwnershipKey(key: string): boolean {
    const normalized = key.toLowerCase().replace(/[-_]/g, '')
    return normalized.includes('ownedlist')
        || normalized.includes('listownership')
        || normalized === 'ownerships'
}

function readCursor(value: unknown): string | undefined {
    const cursor = readString(value)
    return cursor && cursor !== '0' ? cursor : undefined
}

function parseListPage(
    payload: unknown,
    currentUserId: string,
    operation: 'ListOwnerships' | 'ListsManagementPageTimeline',
): { lists: OwnedListSummary[]; cursor: string } {
    if (!isRecord(payload) || !isRecord(payload.data)) {
        if (isRecord(payload) && Array.isArray(payload.errors) && payload.errors.length > 0) {
            throw new XApiError(`X rejected the ${operation} request.`, 'graphql', operation)
        }
        throw new XApiError(
            `The ${operation} response could not be read. X may have changed it.`,
            'contract',
            operation,
        )
    }

    const lists = new Map<string, OwnedListSummary>()
    let cursor = ''
    let foundOwnershipConnection = false
    let foundTimeline = false
    let listRecordCount = 0
    let ownedListRecordCount = 0
    let visited = 0
    const queue: Array<{ value: unknown; underOwnership: boolean; underTimeline: boolean; depth: number }> = [
        { value: payload.data, underOwnership: false, underTimeline: false, depth: 0 },
    ]

    for (let index = 0; index < queue.length && visited < MAX_TRAVERSAL_NODES; index++) {
        const current = queue[index]
        visited++
        if (current.depth > 16) continue

        if (Array.isArray(current.value)) {
            for (const item of current.value) {
                queue.push({
                    value: item,
                    underOwnership: current.underOwnership,
                    underTimeline: current.underTimeline,
                    depth: current.depth + 1,
                })
            }
            continue
        }
        if (!isRecord(current.value)) continue

        if (current.underOwnership || current.underTimeline) {
            const record = readListRecord(current.value)
            if (record) {
                listRecordCount++
                if (isOwnedListRecord(current.value, currentUserId)) {
                    lists.set(record.id, record)
                    ownedListRecordCount++
                }
            }
        }

        if (
            current.underTimeline
            && typeof current.value.entryId === 'string'
            && current.value.entryId.startsWith('cursor-')
            && isRecord(current.value.content)
        ) {
            cursor = readCursor(current.value.content.value) || cursor
        }

        for (const [key, child] of Object.entries(current.value)) {
            const ownershipKey = isOwnershipKey(key)
            const underOwnership = current.underOwnership || ownershipKey
            const timelineKey = key === 'instructions' && Array.isArray(child)
            const underTimeline = current.underTimeline || timelineKey
            if (ownershipKey) foundOwnershipConnection = true
            if (timelineKey) foundTimeline = true

            const normalizedKey = key.toLowerCase().replace(/[-_]/g, '')
            if ((underOwnership || underTimeline) && (normalizedKey === 'cursor' || normalizedKey === 'nextcursor' || normalizedKey === 'endcursor')) {
                cursor = readCursor(child) || cursor
            }

            if (isRecord(child) || Array.isArray(child)) {
                queue.push({ value: child, underOwnership, underTimeline, depth: current.depth + 1 })
            }
        }
    }

    if (!foundOwnershipConnection && !foundTimeline) {
        throw new XApiError(
            `The ${operation} response had no ownership connection. X may have changed it.`,
            'contract',
            operation,
        )
    }
    if (listRecordCount > 0 && ownedListRecordCount === 0) {
        throw new XApiError(
            `The ${operation} response contained no lists owned by the signed-in user.`,
            'contract',
            operation,
        )
    }

    return { lists: [...lists.values()], cursor }
}

export function parseOwnedListsPage(
    payload: unknown,
    currentUserId: string,
): { lists: OwnedListSummary[]; cursor: string } {
    return parseListPage(payload, currentUserId, 'ListOwnerships')
}

export function parseListManagementPage(
    payload: unknown,
    currentUserId: string,
): { lists: OwnedListSummary[]; cursor: string } {
    return parseListPage(payload, currentUserId, 'ListsManagementPageTimeline')
}
