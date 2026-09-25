function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function hasTimelineInstructions(payload: unknown): boolean {
    if (!isRecord(payload) || !isRecord(payload.data)) return false
    const queue: Array<{ value: unknown; depth: number }> = [{ value: payload.data, depth: 0 }]
    let index = 0
    let visited = 0

    while (index < queue.length && visited < 50_000) {
        const current = queue[index++]
        visited++
        if (!isRecord(current.value) || current.depth > 12) continue
        if (Array.isArray(current.value.instructions)) return true
        for (const child of Object.values(current.value)) {
            if (isRecord(child) || Array.isArray(child)) queue.push({ value: child, depth: current.depth + 1 })
        }
    }

    return false
}
