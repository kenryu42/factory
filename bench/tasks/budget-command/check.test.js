import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.js'

const run = (args) => {
  const lines = []
  const code = main(args, (l) => lines.push(l))
  return { code, out: lines.join('\n') }
}
const budgets = (obj) => {
  const file = join(mkdtempSync(join(tmpdir(), 'budget-')), 'budgets.json')
  writeFileSync(file, JSON.stringify(obj))
  return file
}

test('over-budget categories are listed and exit 1', () => {
  const { code, out } = run(['budget', 'examples/transactions.csv', '--budgets', budgets({ coffee: 3, subscriptions: 100, housing: 1400 }), '--rules', 'examples/rules.json'])
  assert.equal(code, 1)
  assert.equal(out.split('\n').filter(Boolean).join('\n'), [
    '2026-02 coffee over by $3.40',
    '2026-03 coffee over by $1.95',
    '2026-03 housing over by $50.00',
    '2026-04 housing over by $50.00',
  ].join('\n'))
})

test('within budget prints the all-clear and exits 0', () => {
  const { code, out } = run(['budget', 'examples/transactions.csv', '--budgets', budgets({ coffee: 100 }), '--rules', 'examples/rules.json'])
  assert.equal(code, 0)
  assert.match(out, /All categories within budget\./)
})
