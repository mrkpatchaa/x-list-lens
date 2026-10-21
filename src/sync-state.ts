import { XApiError } from './x-api'
import { isAbortError } from './abortable'
import type { SyncErrorCode, SyncState } from './shared'

export function toSyncErrorCode(error: unknown): SyncErrorCode {
    if (error instanceof XApiError) return error.kind
    // Only reached when the user did not cancel, so an abort is our own request timeout.
    if (isAbortError(error)) return 'timeout'
    // fetch() rejects with a TypeError when the request itself fails: Chrome says
    // "Failed to fetch", Safari "Load failed". Other TypeErrors are code bugs.
    if (error instanceof TypeError && /fetch|load failed|network/i.test(error.message)) return 'network'
    return 'unknown'
}

export function createDoneState(counts: { lists: number; people: number }, at = Date.now()): SyncState {
    return {
        status: 'done',
        at,
        listCount: counts.lists,
        peopleCount: counts.people,
    }
}

export function createErrorState(error: unknown, at = Date.now()): SyncState {
    return {
        status: 'error',
        at,
        error: error instanceof Error ? error.message : String(error),
        code: toSyncErrorCode(error),
    }
}

export function isSyncCancelled(state: SyncState | undefined, runId: string): boolean {
    return state?.status === 'running' && state.runId === runId && state.cancelRequested === true
}
