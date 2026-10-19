import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from '../src/cli.js'
import { formatMoney, parseAmount } from '../src/money.js'
import { summarizeByMonth } from '../src/summary.js'
import { loadTransactions } from '../src/transactions.js'

test('amounts are integer cents end to end', () => {
  assert.equal(parseAmount('$4.95'), 495)
  assert.equal(parseAmount('-12'), -1200)
  assert.equal(parseAmount('$1,450.00'), 145000)
  assert.equal(formatMoney(495), '$4.95')
  const txns = loadTransactions('date,description,amount\n2026-03-01,a,0.10\n2026-03-02,b,0.20\n')
  assert.deepEqual(txns.map((t) => t.amount), [10, 20])
  assert.equal(summarizeByMonth(txns)['2026-03'].total, 30)
})

test('the summary output does not change', () => {
  const lines = []
  main(['summary', 'examples/transactions.csv', '--rules', 'examples/rules.json'], (l) => lines.push(l))
  assert.ok(lines.includes('2026-04  $1465.49'))
  assert.ok(lines.includes('  groceries        $70.17'))
})
