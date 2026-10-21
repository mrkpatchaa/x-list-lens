import { describe, expect, it } from 'vitest'
import { collectExport, exportFileName, toCsv } from './export'

// A small RFC 4180 reader, so the test checks what a spreadsheet would see.
function parseCsv(text: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        if (quoted) {
            if (char === '"' && text[i + 1] === '"') { cell += '"'; i++ }
            else if (char === '"') quoted = false
            else cell += char
        } else if (char === '"') quoted = true
        else if (char === ',') { row.push(cell); cell = '' }
        else if (char === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++ }
        else cell += char
    }
    if (cell || row.length) { row.push(cell); rows.push(row) }
    return rows
}

describe('export', () => {
    it('round-trips awkward list names through CSV', () => {
        const lists = collectExport(
            { alice: ['1', '2'], bob: ['1'] },
            { '1': 'Design, "UX"\nteam', '2': '=SUM(A1)' },
            {},
        )
        const rows = parseCsv(toCsv(lists))

        expect(rows[0]).toEqual(['list_id', 'list_name', 'handle', 'owned'])
        expect(rows.slice(1)).toEqual([
            ['1', 'Design, "UX"\nteam', 'alice', 'true'],
            ['1', 'Design, "UX"\nteam', 'bob', 'true'],
            ['2', "'=SUM(A1)", 'alice', 'true'],
        ])
    })

    it('guards formulas hidden behind a tab, a carriage return or spaces', () => {
        const lists = collectExport({ alice: ['1', '2', '3'] }, { '1': '\t=1+1', '2': '\r=1+1', '3': '  =1+1' }, {})
        const names = parseCsv(toCsv(lists)).slice(1).map((row) => row[1])

        expect(names).toEqual(["'\t=1+1", "'\r=1+1", "'  =1+1"])
    })

    it('names files by date', () => {
        expect(exportFileName('csv', new Date(2026, 9, 21))).toBe('listlens-2026-10-21.csv')
    })
})
