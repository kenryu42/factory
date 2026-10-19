import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { harnesses } from '../src/harnesses.ts'

// Fixtures are real headless runs of each CLI fixing `add()` in math.js.
// Expected numbers were read out of the fixtures with jq, not computed by the parser.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8')

test('claude-code: reads cost, tokens and the final summary', () => {
  const t = harnesses['claude-code'].parse(fixture('claude-code'))
  assert.equal(t.ok, true)
  assert.deepEqual(t.usage, { inputTokens: 12352, cacheReadTokens: 54211, outputTokens: 688, costUsd: 0.00335591 })
  assert.match(t.finalText, /a \+ b/)
})

test('codex: reads tokens, reports no cost, and keeps the last message', () => {
  const t = harnesses.codex.parse(fixture('codex'))
  assert.equal(t.ok, true)
  assert.deepEqual(t.usage, { inputTokens: 22180, cacheReadTokens: 63744, outputTokens: 313, costUsd: null })
  assert.match(t.finalText, /^Fixed `add\(\)`/)
})

test('pi: sums cost and tokens over every assistant turn', () => {
  const t = harnesses.pi.parse(fixture('pi'))
  assert.equal(t.ok, true)
  assert.equal(t.usage.inputTokens, 3833)
  assert.equal(t.usage.cacheReadTokens, 7424)
  assert.equal(t.usage.outputTokens, 446)
  assert.ok(Math.abs(t.usage.costUsd! - 0.001729644) < 1e-12)
  assert.match(t.finalText, /add\(\)` now returns `a \+ b`/)
})

test('a run cut off before its final event counts as failed', () => {
  for (const [name, harness] of Object.entries(harnesses)) {
    const lines = fixture(name).trim().split('\n')
    const cut = lines.slice(0, Math.floor(lines.length / 2)).join('\n')
    assert.equal(harness.parse(cut).ok, false, `${name} should fail on a cut-off transcript`)
  }
})

test('an empty transcript counts as failed with zero usage', () => {
  for (const harness of Object.values(harnesses)) {
    const t = harness.parse('')
    assert.equal(t.ok, false)
    assert.equal(t.usage.outputTokens, 0)
  }
})
