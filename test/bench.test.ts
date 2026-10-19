import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { cellName, parseConfigs, parseTask } from '../src/bench.ts'

test('configs are harness:model pairs, and the model may hold a slash or a colon', () => {
  assert.deepEqual(parseConfigs('claude-code:haiku, pi:deepseek/deepseek-flash,'), [
    { harness: 'claude-code', model: 'haiku' },
    { harness: 'pi', model: 'deepseek/deepseek-flash' },
  ])
  assert.deepEqual(parseConfigs('pi:ollama/qwen3:32b'), [{ harness: 'pi', model: 'ollama/qwen3:32b' }])
})

test('an unknown harness, a missing model, or no configs at all is rejected', () => {
  assert.throws(() => parseConfigs('gemini:flash'), /harness must be one of claude-code, pi/)
  assert.throws(() => parseConfigs('claude-code:haiku,pi:'), /"pi:": no model/)
  assert.throws(() => parseConfigs('pi'), /no model/)
  assert.throws(() => parseConfigs(' , '), /no bench configs/)
})

test('a task file is the issue: the heading is the title, the rest the body', () => {
  const task = parseTask(readFileSync(new URL('../bench/tasks/negative-money/task.md', import.meta.url), 'utf8'))
  assert.deepEqual(task, {
    title: 'Refunds print as $-12.00',
    body: '`formatMoney(-12)` returns `$-12.00`. It should be `-$12.00`. Positive amounts should not change.',
  })
  assert.throws(() => parseTask('Refunds are wrong\n\nFix them.'), /# Title/)
})

test('each cell has its own result file, with the model made path-safe', () => {
  assert.equal(cellName('negative-money', { harness: 'pi', model: 'deepseek/deepseek-flash' }), 'negative-money__pi__deepseek_deepseek-flash')
  assert.notEqual(cellName('recurring', { harness: 'claude-code', model: 'haiku' }), cellName('recurring', { harness: 'claude-code', model: 'sonnet' }))
})
