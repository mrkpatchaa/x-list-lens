export function getUserIdFromTwid(value: string): string | undefined {
    let decoded = value;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
        } catch {
            break;
        }
    }
    const match = decoded.match(/(?:^|;)u=(\d{1,32})(?:[|;]|$)/);
    return match?.[1];
}

export function getUserIdFromListPayload(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const data = (payload as Record<string, unknown>).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;

    const read = (path: string[]) => {
        let value: unknown = data;
        for (const key of path) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
            value = (value as Record<string, unknown>)[key];
        }
        return value;
    };
    const paths = [
        ['viewer', 'user_results', 'result', 'rest_id'],
        ['viewer', 'result', 'rest_id'],
        ['viewer', 'rest_id'],
        ['user', 'result', 'rest_id'],
        ['user', 'rest_id'],
        ['user_id_str'],
    ];
    for (const path of paths) {
        const value = read(path);
        if (typeof value === 'string' && /^\d{1,32}$/.test(value)) return value;
    }
    return undefined;
}

function readNestedOwnerId(value: Record<string, unknown>): string | undefined {
    const candidates = [value.owner, value.owner_results, value.user_results, value.user];
    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const wrapper = candidate as Record<string, unknown>;
        const result = wrapper.result && typeof wrapper.result === 'object' && !Array.isArray(wrapper.result)
            ? wrapper.result as Record<string, unknown>
            : wrapper;
        const legacy = result.legacy && typeof result.legacy === 'object' && !Array.isArray(result.legacy)
            ? result.legacy as Record<string, unknown>
            : undefined;
        const id = result.rest_id ?? result.id_str ?? legacy?.id_str;
        if (typeof id === 'string' && id.length > 0) return id;
    }
    return undefined;
}

export function isOwnedListRecord(
    record: unknown,
    currentUserId?: string,
    requireExplicitOwnership = false,
): boolean {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const value = record as Record<string, unknown>;

    if (
        value.owned === false
        || value.is_owned === false
        || value.owned_by_viewer === false
        || value.is_owned_by_viewer === false
    ) return false;
    if (value.owned === true || value.owned_by_viewer === true || value.is_owned_by_viewer === true) return true;

    const ownerId = value.owner_id_str
        ?? value.owner_id
        ?? value.ownerId
        ?? value.owner_user_id
        ?? readNestedOwnerId(value);

    if (ownerId !== undefined) return Boolean(currentUserId) && String(ownerId) === currentUserId;
    if (requireExplicitOwnership) return false;
    return true;
}
