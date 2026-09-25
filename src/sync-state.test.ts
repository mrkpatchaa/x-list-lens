import { describe, expect, it } from 'vitest'
import { XApiError } from './x-api'
import { createDoneState, createErrorState, isSyncCancelled, toSyncErrorCode } from './sync-state'

describe('sync state transitions', () => {
    it('records useful completion metadata', () => {
        expect(createDoneState({ lists: 3, people: 12 }, 1234)).toEqual({
            status: 'done',
            at: 1234,
            listCount: 3,
            peopleCount: 12,
        })
    })

    it('maps API failures to stable user-facing codes', () => {
        expect(toSyncErrorCode(new XApiError('private details', 'rate_limit'))).toBe('rate_limit')
        expect(toSyncErrorCode(new Error('private details'))).toBe('unknown')
        expect(createErrorState(new Error('private details'), 1234)).toEqual({
            status: 'error',
            at: 1234,
            error: 'private details',
            code: 'unknown',
        })
    })

    it('only honors cancellation for the active run', () => {
        expect(isSyncCancelled({
            status: 'running',
            runId: 'run-1',
            done: 0,
            total: 2,
            cancelRequested: true,
        }, 'run-1')).toBe(true)
        expect(isSyncCancelled({
            status: 'running',
            runId: 'run-2',
            done: 0,
            total: 2,
            cancelRequested: true,
        }, 'run-1')).toBe(false)
        expect(isSyncCancelled({ status: 'idle' }, 'run-1')).toBe(false)
    })
})
