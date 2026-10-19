import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCsv } from '../src/csv.js'

test('quoted fields keep their commas and escaped quotes', () => {
  const rows = parseCsv('date,description,amount\n2026-03-04,"Coffee, large",5.25\n2026-03-05,"Say ""hi"", Bob",1.00\n2026-03-06,Plain,2.00\n')
  assert.deepEqual(rows, [
    { date: '2026-03-04', description: 'Coffee, large', amount: '5.25' },
    { date: '2026-03-05', description: 'Say "hi", Bob', amount: '1.00' },
    { date: '2026-03-06', description: 'Plain', amount: '2.00' },
  ])
})
