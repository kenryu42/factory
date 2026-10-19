import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadAgent, parseAgent } from '../src/agents.ts'

test('the shipped implement agent loads with a model for every harness', () => {
  const agent = loadAgent(fileURLToPath(new URL('..', import.meta.url)), 'implement')
  assert.equal(agent.defaultHarness, 'claude-code')
  assert.deepEqual(Object.keys(agent.models).sort(), ['claude-code', 'codex', 'pi'])
  assert.match(agent.prompt, /Do not commit/)
})

test('a broken agent file fails with a message naming the problem', () => {
  const full = '---\nharness: pi\nclaude-code: sonnet\ncodex: gpt\npi: deepseek/x\n---\nDo it.\n'
  assert.throws(() => parseAgent('x', full.replace('harness: pi', 'harness: gemini')), /harness must be one of/)
  assert.throws(() => parseAgent('x', full.replace('codex: gpt\n', '')), /missing model for codex/)
  assert.throws(() => parseAgent('x', 'Do it.'), /missing --- frontmatter/)
})
