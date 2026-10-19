import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCsv } from '../src/csv.js'

test('CRLF rows, multi-line quoted fields, and escaped quotes', () => {
  const rows = parseCsv('date,description,amount\r\n2026-03-04,"Dinner\nwith team",40.00\r\n\r\n2026-03-05,"A ""q"", b",1.00\r\n2026-03-06,Plain,2.00')
  assert.deepEqual(rows, [
    { date: '2026-03-04', description: 'Dinner\nwith team', amount: '40.00' },
    { date: '2026-03-05', description: 'A "q", b', amount: '1.00' },
    { date: '2026-03-06', description: 'Plain', amount: '2.00' },
  ])
})

test('plain LF files still parse', () => {
  assert.deepEqual(parseCsv('date,description,amount\n2026-03-02,Starbucks,4.95\n'), [{ date: '2026-03-02', description: 'Starbucks', amount: '4.95' }])
})
