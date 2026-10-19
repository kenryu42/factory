import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decide } from '../src/guard.ts'

// Shaped like the `issues` webhook payload GitHub sends for a labeled issue.
function labeled(opts: { label?: string; sender?: string; author?: string; labels?: string[] } = {}) {
  const label = opts.label ?? 'factory'
  return {
    action: 'labeled',
    label: { name: label },
    sender: { login: opts.sender ?? 'kenryu42' },
    repository: { full_name: 'kenryu42/factory-sandbox', default_branch: 'main', owner: { login: 'kenryu42' } },
    issue: {
      number: 7,
      title: 'Add a --json flag',
      body: 'Export should support JSON.',
      user: { login: opts.author ?? 'kenryu42' },
      labels: (opts.labels ?? [label]).map((name) => ({ name })),
    },
  }
}

test('the owner labeling their own issue starts a run with the default harness', () => {
  assert.deepEqual(decide(labeled()), {
    run: true,
    plan: {
      harness: null,
      baseBranch: 'main',
      issue: { repo: 'kenryu42/factory-sandbox', number: 7, title: 'Add a --json flag', body: 'Export should support JSON.' },
    },
  })
})

test('a harness label picks the harness', () => {
  const d = decide(labeled({ labels: ['harness:pi', 'factory'] }))
  assert.equal(d.run && d.plan.harness, 'pi')
})

test('a stranger cannot start a run', () => {
  const d = decide(labeled({ sender: 'stranger' }))
  assert.equal(d.run, false)
})

test("the owner labeling a stranger's issue does not start a run", () => {
  const d = decide(labeled({ author: 'stranger' }))
  assert.equal(d.run, false)
})

test('other labels do not start a run', () => {
  assert.equal(decide(labeled({ label: 'bug' })).run, false)
  assert.equal(decide({ ...labeled(), action: 'opened' }).run, false)
})

test('an unknown or ambiguous harness label does not start a run', () => {
  assert.equal(decide(labeled({ labels: ['harness:gemini', 'factory'] })).run, false)
  assert.equal(decide(labeled({ labels: ['harness:pi', 'harness:codex', 'factory'] })).run, false)
})
