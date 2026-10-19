import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadAgent, parseAgent, parseVerdict } from '../src/agents.ts'

const agentsDir = fileURLToPath(new URL('../agents', import.meta.url))

test('every shipped agent loads with a model for every harness', () => {
  for (const name of ['spec', 'implement', 'review', 'improve']) {
    const agent = loadAgent(agentsDir, name)
    assert.equal(agent.defaultHarness, 'claude-code', name)
    assert.deepEqual(Object.keys(agent.models).sort(), ['claude-code', 'pi'], name)
  }
  assert.match(loadAgent(agentsDir, 'implement').prompt, /Do not commit/)
})

test('the review prompt asks for the verdict line the factory parses', () => {
  const prompt = loadAgent(agentsDir, 'review').prompt
  assert.equal(parseVerdict(prompt.match(/`(VERDICT: approve)`/)![1]), 'approve')
  assert.equal(parseVerdict(prompt.match(/`(VERDICT: request_changes)`/)![1]), 'request_changes')
})

test('a broken agent file fails with a message naming the problem', () => {
  const full = '---\nharness: pi\nclaude-code: sonnet\npi: deepseek/x\n---\nDo it.\n'
  assert.throws(() => parseAgent('spec', full.replace('harness: pi', 'harness: gemini')), /harness must be one of/)
  assert.throws(() => parseAgent('spec', full.replace('pi: deepseek/x\n', '')), /missing model for pi/)
  assert.throws(() => parseAgent('spec', 'Do it.'), /missing --- frontmatter/)
})

const review = (findings: string, last: string) => `The change resolves the issue.\n\n${findings}\n\n${last}`

test('a review ending in a verdict line yields that verdict', () => {
  assert.equal(parseVerdict(review('No blocking findings.', 'VERDICT: approve')), 'approve')
  assert.equal(parseVerdict(review('1. `src/export.ts:42` drops the last row. Blocking.', 'VERDICT: request_changes')), 'request_changes')
  assert.equal(parseVerdict(review('No blocking findings.', '**VERDICT: approve**\n')), 'approve')
})

test('the last VERDICT line decides, even over an earlier valid one', () => {
  assert.equal(parseVerdict('I almost wrote VERDICT: approve but\nVERDICT: approve\nthen tests failed.\nVERDICT: request_changes'), 'request_changes')
  assert.equal(parseVerdict('VERDICT: approve\nOn reflection:\nVERDICT: lgtm'), null)
})

test('a review without a readable verdict has none', () => {
  assert.equal(parseVerdict(''), null)
  assert.equal(parseVerdict(review('Looks fine.', 'Overall I approve.')), null)
  assert.equal(parseVerdict(review('Looks fine.', 'VERDICT: Approve')), null)
})
