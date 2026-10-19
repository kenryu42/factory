import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.js'
import { formatMoney } from '../src/money.js'

const run = (args) => {
  const lines = []
  main(args, (l) => lines.push(l))
  return lines
}
const line = (category, amount, pct) => `  ${category.padEnd(16)} ${formatMoney(amount)}${pct === null ? '' : `  ${pct}%`}`

test('shares use largest remainders and add up to 100', () => {
  const lines = run(['summary', 'examples/transactions.csv', '--rules', 'examples/rules.json', '--percent'])
  for (const l of [line('housing', 1450, 94), line('groceries', 70.17, 5), line('subscriptions', 15.49, 1), line('coffee', 4.95, 0), line('coffee', 6.4, 100), line('subscriptions', 15.49, 1)]) {
    assert.ok(lines.includes(l), `missing "${l}" in\n${lines.join('\n')}`)
  }
  assert.ok(lines.includes(line('housing', 1450, 99)), lines.join('\n'))
})

test('ties go to the first name, non-positive categories get no percent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pct-'))
  writeFileSync(join(dir, 't.csv'), 'date,description,amount\n2026-05-01,Cafe,1.00\n2026-05-02,Food,1.00\n2026-05-03,Tea,1.00\n2026-05-04,Return,-10.00\n')
  writeFileSync(join(dir, 'r.json'), JSON.stringify([{ match: 'Cafe', category: 'coffee' }, { match: 'Food', category: 'food' }, { match: 'Tea', category: 'tea' }, { match: 'Return', category: 'returns' }]))
  const lines = run(['summary', join(dir, 't.csv'), '--rules', join(dir, 'r.json'), '--percent'])
  assert.ok(lines.includes(line('coffee', 1, 34)), lines.join('\n'))
  assert.ok(lines.includes(line('food', 1, 33)), lines.join('\n'))
  assert.ok(lines.includes(line('tea', 1, 33)), lines.join('\n'))
  assert.ok(lines.includes(line('returns', -10, null)), lines.join('\n'))
})

test('without --percent the table is unchanged', () => {
  assert.ok(run(['summary', 'examples/transactions.csv', '--rules', 'examples/rules.json']).includes('  groceries        $70.17'))
})
