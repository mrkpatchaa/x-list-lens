export function getUserIdFromTwid(value: string): string | undefined {
    const match = decodeURIComponent(value).match(/(?:^|;)u=(\d{1,32})(?:[|;]|$)/);
    return match?.[1];
}

export function isOwnedListRecord(record: unknown, currentUserId?: string): boolean {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (!currentUserId) return true;

    const value = record as Record<string, unknown>;
    if (value.owned === false || value.is_owned === false) return false;

    const owner = value.owner && typeof value.owner === 'object' && !Array.isArray(value.owner)
        ? value.owner as Record<string, unknown>
        : undefined;
    const ownerId = value.owner_id_str
        ?? value.ownerId
        ?? owner?.id_str
        ?? owner?.rest_id;

    if (ownerId !== undefined) return String(ownerId) === currentUserId;
    return true;
}
