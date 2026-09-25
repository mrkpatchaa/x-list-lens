import { XApiError } from './x-api'
import type { SyncErrorCode, SyncState } from './shared'

export function toSyncErrorCode(error: unknown): SyncErrorCode {
    return error instanceof XApiError ? error.kind : 'unknown'
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
