import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from '../src/cli.js'

const run = (args) => {
  const lines = []
  const code = main(args, (l) => lines.push(l))
  return { code, lines }
}

test('--json prints the month summary as one line of JSON', () => {
  const { code, lines } = run(['summary', 'examples/transactions.csv', '--rules', 'examples/rules.json', '--json'])
  assert.equal(code, 0)
  assert.equal(lines.length, 1)
  const months = JSON.parse(lines[0])
  assert.equal(months['2026-04'].total, 1465.49)
  assert.equal(months['2026-03'].byCategory.groceries, 70.17)
  assert.equal(months['2026-03'].total, 1540.61)
})

test('without --json the table is unchanged', () => {
  const { lines } = run(['summary', 'examples/transactions.csv', '--rules', 'examples/rules.json'])
  assert.ok(lines.includes('2026-04  $1465.49'))
})
