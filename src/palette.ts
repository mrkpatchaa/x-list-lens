// Each color has at least 3:1 contrast on X's light (#ffffff), dim (#15202b)
// and dark (#000000) backgrounds.
export const LIST_COLORS = [
    { name: 'Blue', hex: '#1d8cd8' },
    { name: 'Pink', hex: '#d6336c' },
    { name: 'Orange', hex: '#e8590c' },
    { name: 'Green', hex: '#2f9e44' },
    { name: 'Violet', hex: '#7950f2' },
    { name: 'Teal', hex: '#0c8599' },
    { name: 'Purple', hex: '#ae3ec9' },
    { name: 'Olive', hex: '#5c940d' },
] as const

export function listColor(index: unknown): (typeof LIST_COLORS)[number] | undefined {
    return typeof index === 'number' && Number.isInteger(index) ? LIST_COLORS[index] : undefined
}
