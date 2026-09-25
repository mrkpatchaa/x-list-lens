export function createAbortError(): DOMException {
    return new DOMException('The operation was aborted.', 'AbortError')
}

export function isAbortError(error: unknown): boolean {
    return error instanceof DOMException
        ? error.name === 'AbortError'
        : Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
}

export function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }
    if (signal.aborted) return Promise.reject(createAbortError())

    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer)
            reject(createAbortError())
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        signal.addEventListener('abort', onAbort, { once: true })
    })
}
