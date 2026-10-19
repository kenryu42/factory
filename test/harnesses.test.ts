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

test('claude-code steps: the Edit call on math.js, its result, and the final message', () => {
  const steps = harnesses['claude-code'].steps(fixture('claude-code'))
  const edit = steps.findIndex((s) => s.kind === 'tool_call' && s.tool === 'Edit')
  assert.ok(edit >= 0, 'has an Edit tool call')
  const call = steps[edit]
  assert.ok(call.kind === 'tool_call' && call.input.includes('/work/math.js') && call.input.includes('return a + b;'))
  assert.deepEqual(steps[edit + 1], { kind: 'tool_result', output: 'The file /work/math.js has been updated successfully.', isError: false })
  const last = steps.at(-1)!
  assert.ok(last.kind === 'message' && /a \+ b/.test(last.text))
  assert.equal(steps.filter((s) => s.kind === 'tool_call').length, 3)
})

test('pi steps: the edit call, the failed git diff, and the final text', () => {
  const steps = harnesses.pi.steps(fixture('pi'))
  assert.ok(steps.some((s) => s.kind === 'tool_call' && s.tool === 'edit' && s.input.includes('/work/math.js') && s.input.includes('return a + b;')))
  assert.ok(steps.some((s) => s.kind === 'tool_result' && s.isError && s.output.includes('Not a git repository')))
  const last = steps.at(-1)!
  assert.ok(last.kind === 'message' && /add\(\)` now returns `a \+ b`/.test(last.text))
})

test('steps hold readable text, never raw events or thinking', () => {
  for (const [name, harness] of Object.entries(harnesses)) {
    const steps = harness.steps(fixture(name))
    assert.ok(steps.length > 0, `${name} has steps`)
    for (const s of steps) {
      const text = s.kind === 'message' ? s.text : s.kind === 'tool_call' ? s.input : s.output
      assert.doesNotMatch(text, /^\s*\{"(type|id)"/, `${name} step is a raw JSON event`)
    }
    assert.ok(!steps.some((s) => s.kind === 'message' && /^The bug is obvious/.test(s.text)), `${name} leaks thinking`)
  }
})
