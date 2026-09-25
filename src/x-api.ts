import { isValidListId, type ListCache } from './shared'

export type XApiErrorKind =
    | 'auth'
    | 'contract'
    | 'graphql'
    | 'http'
    | 'interrupted'
    | 'network'
    | 'rate_limit'
    | 'server'
    | 'setup'
    | 'storage'
    | 'timeout'
    | 'unknown'

export class XApiError extends Error {
    kind: XApiErrorKind
    operation?: string

    constructor(
        message: string,
        kind: XApiErrorKind,
        operation?: string,
        options?: ErrorOptions,
    ) {
        super(message, options)
        this.name = 'XApiError'
        this.kind = kind
        this.operation = operation
    }
}

type JsonRecord = Record<string, unknown>
type ListSummary = { id: string; name: string }

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/
const MAX_TRAVERSAL_NODES = 50_000

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function isValidHandle(value: unknown): value is string {
    return typeof value === 'string' && HANDLE_RE.test(value)
}

export function assertSuccessfulGraphQLPayload(value: unknown, operation: string): JsonRecord {
    if (!isRecord(value)) {
        throw new XApiError(`X returned an unreadable response for ${operation}.`, 'contract', operation)
    }

    if (Array.isArray(value.errors) && value.errors.length > 0) {
        throw new XApiError(`X rejected the ${operation} request.`, 'graphql', operation)
    }

    if (!isRecord(value.data)) {
        throw new XApiError(`X returned no data for ${operation}.`, 'contract', operation)
    }

    return value
}

function readPath(root: unknown, path: readonly string[]): unknown {
    let current = root;
    for (const key of path) {
        if (!isRecord(current)) return undefined;
        current = current[key];
    }
    return current;
}

function findTimelineInstructions(data: JsonRecord): unknown[] | undefined {
    const knownPaths = [
        ['list', 'members_timeline', 'timeline', 'instructions'],
        ['list', 'members_timeline', 'instructions'],
        ['list_management', 'timeline', 'timeline', 'instructions'],
        ['list_management', 'timeline', 'instructions'],
        ['list_management_timeline', 'timeline', 'instructions'],
        ['user', 'list_management_timeline', 'timeline', 'instructions'],
        ['viewer', 'list_management_timeline', 'timeline', 'instructions'],
        ['listManagement', 'timeline', 'instructions'],
    ]

    for (const path of knownPaths) {
        const instructions = readPath(data, path);
        if (Array.isArray(instructions)) return instructions;
    }

    let visited = 0;
    let queueIndex = 0;
    const queue: Array<{ value: unknown; depth: number }> = [{ value: data, depth: 0 }];
    while (queueIndex < queue.length && visited < MAX_TRAVERSAL_NODES) {
        const current = queue[queueIndex++];
        visited++;
        if (!isRecord(current.value) || current.depth > 12) continue;
        if (Array.isArray(current.value.instructions)) return current.value.instructions;
        for (const child of Object.values(current.value)) {
            if (isRecord(child) || Array.isArray(child)) {
                queue.push({ value: child, depth: current.depth + 1 });
            }
        }
    }

    return undefined;
}

function timelineEntries(instructions: unknown[]): JsonRecord[] {
    const entries: JsonRecord[] = [];
    for (const instruction of instructions) {
        if (!isRecord(instruction) || !Array.isArray(instruction.entries)) continue;
        for (const entry of instruction.entries) {
            if (isRecord(entry)) entries.push(entry);
        }
    }
    return entries
}

function readCursor(entry: JsonRecord): string {
    if (typeof entry.entryId !== 'string' || !entry.entryId.startsWith('cursor-bottom')) return '';
    if (!isRecord(entry.content)) return '';
    return getString(entry.content.value) || '';
}

function readMemberHandle(entry: JsonRecord): string | undefined {
    const itemContent = readPath(entry, ['content', 'itemContent']);
    if (!isRecord(itemContent) || !isRecord(itemContent.user_results)) return undefined;
    const result = itemContent.user_results.result;
    if (!isRecord(result)) return undefined;

    const legacy = isRecord(result.legacy) ? getString(result.legacy.screen_name) : undefined;
    const core = isRecord(result.core) ? getString(result.core.screen_name) : undefined;
    const handle = core || legacy;
    return handle && isValidHandle(handle) ? handle.toLowerCase() : undefined;
}

export function parseMembersPage(payload: unknown): { handles: string[]; cursor: string } {
    const data = assertSuccessfulGraphQLPayload(payload, 'ListMembers');
    const instructions = findTimelineInstructions(data);
    if (!instructions) {
        throw new XApiError('The list members response could not be read. X may have changed it.', 'contract', 'ListMembers')
    }

    const handles = new Set<string>();
    let cursor = '';
    let unexpectedEntry = false;

    for (const entry of timelineEntries(instructions)) {
        const entryCursor = readCursor(entry);
        if (entryCursor) {
            cursor = entryCursor;
            continue;
        }

        const handle = readMemberHandle(entry);
        if (handle) handles.add(handle);
        else unexpectedEntry = true;
    }

    if (unexpectedEntry && handles.size === 0) {
        throw new XApiError('The list members response had an unknown shape. X may have changed it.', 'contract', 'ListMembers')
    }

    return { handles: [...handles], cursor }
}

function readListRecord(value: unknown): ListSummary | undefined {
    if (!isRecord(value)) return undefined;
    const id = getString(value.id_str);
    const name = getString(value.name);
    const hasListShape = value.member_count !== undefined || value.mode !== undefined;
    if (!id || !name || !hasListShape || !isValidListId(id) || name.length > 200) return undefined;
    return { id, name };
}

function isListPathKey(key: string): boolean {
    return /list/i.test(key);
}

function collectListsFromEntry(entry: JsonRecord, into: Map<string, ListSummary>): void {
    const visit = (value: unknown, path: string[], state: { count: number }): void => {
        if (state.count++ >= MAX_TRAVERSAL_NODES) return;
        if (Array.isArray(value)) {
            for (const item of value) visit(item, path, state);
            return;
        }
        if (!isRecord(value)) return;

        const listContext = path.some(isListPathKey);
        const record = readListRecord(value);
        if (listContext && record) into.set(record.id, record);

        for (const [key, child] of Object.entries(value)) {
            if (isRecord(child) || Array.isArray(child)) visit(child, [...path, key], state);
        }
    };

    // Only records below list-specific path keys are accepted. This supports
    // X's occasional wrapper changes without mistaking embedded users for lists.
    visit(entry, ['entry'], { count: 0 });
}

export function parseListsPage(payload: unknown): { lists: ListSummary[]; cursor: string } {
    const data = assertSuccessfulGraphQLPayload(payload, 'ListsManagementPageTimeline');
    const instructions = findTimelineInstructions(data);
    if (!instructions) {
        throw new XApiError('The lists response could not be read. X may have changed it.', 'contract', 'ListsManagementPageTimeline')
    }

    const lists = new Map<string, ListSummary>();
    let cursor = '';
    for (const entry of timelineEntries(instructions)) {
        const entryCursor = readCursor(entry);
        if (entryCursor) cursor = entryCursor;
        collectListsFromEntry(entry, lists);
    }

    return { lists: [...lists.values()], cursor }
}

export function replaceListMembership(
    cache: ListCache,
    listId: string,
    members: ReadonlySet<string>,
): ListCache {
    const next: ListCache = {};

    for (const [handle, listIds] of Object.entries(cache)) {
        const updated = listIds.filter((id) => id !== listId);
        if (updated.length > 0) next[handle] = updated;
    }

    for (const handle of members) {
        const normalized = handle.toLowerCase();
        const listIds = next[normalized] || [];
        if (!listIds.includes(listId)) listIds.push(listId);
        next[normalized] = listIds;
    }

    return next
}
