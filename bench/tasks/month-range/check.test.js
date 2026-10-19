import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from '../src/cli.js'

const run = (args) => {
  const lines = []
  const errors = []
  const origError = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try {
    const code = main(args, (l) => lines.push(l))
    return { code, lines, all: [...lines, ...errors].join('\n') }
  } finally {
    console.error = origError
  }
}
const months = (lines) => lines.filter((l) => /^\d{4}-\d{2} /.test(l)).map((l) => l.slice(0, 7))
const base = ['summary', 'examples/transactions.csv', '--rules', 'examples/rules.json']

test('from and to are inclusive and work alone', () => {
  assert.deepEqual(months(run([...base, '--from', '2026-03', '--to', '2026-03']).lines), ['2026-03'])
  assert.deepEqual(months(run([...base, '--from', '2026-03']).lines), ['2026-03', '2026-04'])
  assert.deepEqual(months(run([...base, '--to', '2026-03']).lines), ['2026-02', '2026-03'])
  assert.deepEqual(months(run(base).lines), ['2026-02', '2026-03', '2026-04'])
})

test('a malformed month is an error with exit code 2', () => {
  const r = run([...base, '--from', '2026-3'])
  assert.equal(r.code, 2)
  assert.match(r.all, /2026-3/)
  assert.deepEqual(months(r.lines), [])
})
