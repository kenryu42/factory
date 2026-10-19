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
    return { code, out: [...lines, ...errors].join('\n') }
  } finally {
    console.error = origError
  }
}

test('--help and no arguments print usage and exit 0', () => {
  for (const args of [['--help'], []]) {
    const { code, out } = run(args)
    assert.equal(code, 0)
    assert.match(out, /^Usage: ledger/m)
    assert.match(out, /summary/)
  }
})

test('an unknown command names itself, prints usage, and exits 2', () => {
  const { code, out } = run(['frobnicate'])
  assert.equal(code, 2)
  assert.match(out, /frobnicate/)
  assert.match(out, /Usage: ledger/)
})
