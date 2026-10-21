import { XApiError } from './x-api'
import { isOwnedListRecord } from './list-filter'

export type OwnedListSummary = { id: string; name: string; memberCount?: number; ownerHandle?: string }
// `followed` holds lists the user follows but does not own. Only the Lists
// management response reports them; ListOwnerships returns owned lists only.
export type ListPageResult = { lists: OwnedListSummary[]; followed: OwnedListSummary[]; cursor: string }

type JsonRecord = Record<string, unknown>

const MAX_TRAVERSAL_NODES = 50_000
const LIST_ID_RE = /^\d{1,32}$/
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/

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

    const summary: OwnedListSummary = { id, name }
    const count = value.member_count
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0) summary.memberCount = count
    const ownerHandle = readOwnerHandle(value)
    if (ownerHandle) summary.ownerHandle = ownerHandle
    return summary
}

function readOwnerHandle(value: JsonRecord): string | undefined {
    const owner = isRecord(value.user_results) && isRecord(value.user_results.result) ? value.user_results.result : undefined
    if (!owner) return undefined
    const handle = (isRecord(owner.core) ? readString(owner.core.screen_name) : undefined)
        ?? (isRecord(owner.legacy) ? readString(owner.legacy.screen_name) : undefined)
    return handle && HANDLE_RE.test(handle) ? handle.toLowerCase() : undefined
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
): ListPageResult {
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
    const followed = new Map<string, OwnedListSummary>()
    let cursor = ''
    let foundOwnershipConnection = false
    let foundTimeline = false
    let listRecordCount = 0
    let ownedListRecordCount = 0
    let visited = 0
    type QueueItem = { value: unknown; underOwnership: boolean; underTimeline: boolean; underSuggestion: boolean; depth: number }
    const queue: QueueItem[] = [
        { value: payload.data, underOwnership: false, underTimeline: false, underSuggestion: false, depth: 0 },
    ]

    for (let index = 0; index < queue.length && visited < MAX_TRAVERSAL_NODES; index++) {
        const current = queue[index]
        visited++
        if (current.depth > 16) continue

        if (Array.isArray(current.value)) {
            for (const item of current.value) {
                queue.push({ ...current, value: item, depth: current.depth + 1 })
            }
            continue
        }
        if (!isRecord(current.value)) continue
        // "Discover new Lists" records are never cached, whatever their flags say.
        const underSuggestion = current.underSuggestion || isSuggestionModule(current.value)

        if (current.underOwnership || current.underTimeline) {
            const record = readListRecord(current.value)
            if (record) {
                listRecordCount++
                if (isOwnedListRecord(current.value, currentUserId)) {
                    lists.set(record.id, record)
                    ownedListRecordCount++
                } else if (operation === 'ListsManagementPageTimeline' && current.value.following === true && !underSuggestion) {
                    followed.set(record.id, record)
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
                queue.push({ value: child, underOwnership, underTimeline, underSuggestion, depth: current.depth + 1 })
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
    if (listRecordCount > 0 && ownedListRecordCount === 0 && followed.size === 0) {
        throw new XApiError(
            `The ${operation} response contained no lists owned by the signed-in user.`,
            'contract',
            operation,
        )
    }

    return { lists: [...lists.values()], followed: [...followed.values()], cursor }
}

// X wraps list recommendations in a module whose clientEventInfo names them.
function isSuggestionModule(value: JsonRecord): boolean {
    const info = isRecord(value.clientEventInfo) ? value.clientEventInfo : undefined
    if (!info) return false
    const details = isRecord(info.details) && isRecord(info.details.timelinesDetails) ? info.details.timelinesDetails : undefined
    return info.component === 'suggest_list_to_follow' || details?.injectionType === 'ListToFollow'
}

export function parseOwnedListsPage(
    payload: unknown,
    currentUserId: string,
): ListPageResult {
    return parseListPage(payload, currentUserId, 'ListOwnerships')
}

export function parseListManagementPage(
    payload: unknown,
    currentUserId: string,
): ListPageResult {
    return parseListPage(payload, currentUserId, 'ListsManagementPageTimeline')
}
