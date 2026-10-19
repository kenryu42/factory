import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.js'
import { dedupe } from '../src/transactions.js'

test('dedupe drops later exact duplicates and keeps order', () => {
  const a = { date: '2026-03-01', description: 'Rent', amount: 1450, category: 'housing' }
  const b = { date: '2026-03-02', description: 'Coffee', amount: 4.95, category: 'coffee' }
  const c = { date: '2026-03-02', description: 'Coffee', amount: 5.95, category: 'coffee' }
  assert.deepEqual(dedupe([a, b, { ...a }, c, { ...b }]), [a, b, c])
})

test('summary --dedupe counts duplicated rows once', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dedupe-')), 't.csv')
  writeFileSync(file, 'date,description,amount\n2026-03-01,Rent,1450.00\n2026-03-01,Rent,1450.00\n2026-03-02,Coffee,4.00\n')
  const lines = []
  main(['summary', file, '--dedupe'], (l) => lines.push(l))
  assert.ok(lines.includes('2026-03  $1454.00'), lines.join('\n'))
  const plain = []
  main(['summary', file], (l) => plain.push(l))
  assert.ok(plain.includes('2026-03  $2904.00'))
})
