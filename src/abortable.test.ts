import { describe, expect, it } from 'vitest'
import { isAbortError, waitWithAbort } from './abortable'

describe('abortable waits', () => {
    it('rejects immediately when the signal is aborted', async () => {
        const controller = new AbortController()
        const pending = waitWithAbort(10_000, controller.signal)
        controller.abort()

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('resolves normally when the wait is not aborted', async () => {
        await expect(waitWithAbort(1)).resolves.toBeUndefined()
    })

    it('recognizes abort errors from fetch and timers', () => {
        expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true)
        expect(isAbortError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true)
        expect(isAbortError(new Error('network failed'))).toBe(false)
    })
})
