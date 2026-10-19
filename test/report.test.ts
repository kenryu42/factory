import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { prOutcome, renderReport, summarize, type PrView } from '../src/report.ts'
import type { ReportRow, StageRun } from '../src/types.ts'

// A real `gh pr view --json ...` payload for an open factory PR: one CodeRabbit comment, one factory commit.
const realPr = (): PrView => JSON.parse(readFileSync(new URL('./fixtures/pr-view.json', import.meta.url), 'utf8'))
const repo = 'kenryu42/factory-sandbox'

test('an open factory PR with only a bot comment has no human touches', () => {
  assert.deepEqual(prOutcome(repo, realPr(), false), { outcome: 'open', humanTouches: 0 })
})

test("the owner's comment and review on a merged PR count as two touches", () => {
  const pr = realPr()
  pr.state = 'MERGED'
  pr.mergedAt = '2026-10-20T00:00:00Z'
  pr.comments.push({ author: { login: 'kenryu42' } })
  pr.reviews.push({ author: { login: 'kenryu42' } })
  assert.deepEqual(prOutcome(repo, pr, false), { outcome: 'merged', humanTouches: 2 })
})

test("an owner's commit counts as a touch", () => {
  const pr = realPr()
  pr.commits.push({ authors: [{ login: 'kenryu42' }] })
  assert.equal(prOutcome(repo, pr, false).humanTouches, 1)
})

test('a merged PR with a merged revert is reverted', () => {
  const pr = realPr()
  pr.state = 'MERGED'
  assert.equal(prOutcome(repo, pr, true).outcome, 'reverted')
})

test('a closed PR is closed', () => {
  const pr = realPr()
  pr.state = 'CLOSED'
  assert.equal(prOutcome(repo, pr, false).outcome, 'closed')
})

function row(over: Partial<ReportRow>): ReportRow {
  return {
    id: 'r1', startedAt: '2026-10-19T05:30:00Z', trigger: 'issue#1', factorySha: 'f', kind: 'implement', task: null, issueNumber: 1,
    harness: 'claude-code', model: 'sonnet', repo, baseSha: 'b', branch: null, prUrl: null, status: 'no_changes', verdict: null,
    stages: [], inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: null, wallTimeS: 60,
    runUrl: 'https://github.com/kenryu42/factory/actions/runs/1', outcome: null, humanTouches: null, ...over,
  }
}

function stage(over: Partial<StageRun>): StageRun {
  return {
    agent: 'implement', round: 0, harness: 'claude-code', model: 'claude-sonnet-5', billing: 'subscription', ok: true, verdict: null,
    usage: { inputTokens: 1000, cacheReadTokens: 5000, outputTokens: 300, costUsd: 0.25 },
    startedAt: '2026-10-19T05:30:00Z', wallTimeS: 120, transcript: 'stored', ...over,
  }
}

const pr = (n: number) => ({ status: 'pr_opened' as const, prUrl: `https://github.com/${repo}/pull/${n}`, branch: `factory/issue-${n}` })

test('summary totals cost over priced runs and divides it by opened PRs', () => {
  const s = summarize([
    row({ id: 'a', ...pr(1), costUsd: 0.5, outcome: 'merged', humanTouches: 2 }),
    row({ id: 'b', ...pr(2), costUsd: 0.25, outcome: 'reverted', humanTouches: 0 }),
    row({ id: 'c', ...pr(3), harness: 'pi', costUsd: null, outcome: null, humanTouches: null }),
    row({ id: 'd', status: 'agent_failed', costUsd: 0.75 }),
  ])
  assert.equal(s.runs, 4)
  assert.equal(s.prsOpened, 3)
  assert.equal(s.totalCostUsd, 1.5)
  assert.equal(s.costPerPrUsd, 0.5)
  assert.equal(s.merged, 2)
  assert.equal(s.reverted, 1)
  assert.equal(s.avgHumanTouches, 1)
  assert.deepEqual(s.byStatus, { pr_opened: 3, agent_failed: 1 })
  assert.deepEqual(s.byHarness, {
    'claude-code': { runs: 3, costUsd: 1.5 },
    pi: { runs: 1, costUsd: null },
  })
})

test('a summary with no PRs reports no cost per PR and no touches average', () => {
  const s = summarize([row({ costUsd: 0.1 })])
  assert.equal(s.costPerPrUsd, null)
  assert.equal(s.avgHumanTouches, null)
})

test('the page holds the run, and transcript text cannot close its data script', () => {
  const html = renderReport({
    generatedAt: '2026-10-19T06:00:00Z',
    rows: [row({ id: 'run-42' })],
    steps: { 'run-42': { 'implement-0': [{ kind: 'message', text: 'look </script><img src=x>' }] } },
  })
  assert.ok(html.includes('run-42'))
  assert.equal(html.split('</script>').length - 1, 2, 'one close for the data script, one for the page script')
  assert.ok(!html.includes('</script><img'))
  assert.ok(html.includes('\\u003c/script>\\u003cimg src=x>'))
  const data = html.match(/<script type="application\/json" id="report-data">([^<]*)<\/script>/)
  assert.ok(data, 'data script is intact and holds no raw <')
  assert.equal(JSON.parse(data[1]).steps['run-42']['implement-0'][0].text, 'look </script><img src=x>')
})

test('long tool output is cut in the page data', () => {
  const html = renderReport({
    generatedAt: '2026-10-19T06:00:00Z',
    rows: [row({ id: 'r' })],
    steps: { r: { 'implement-0': [{ kind: 'tool_result', output: 'x'.repeat(10_000), isError: false }] } },
  })
  const data = JSON.parse(html.match(/id="report-data">([^<]*)</)![1])
  const out: string = data.steps.r['implement-0'][0].output
  assert.ok(out.length < 4100)
  assert.match(out, /6000 more characters cut/)
})

test('a revised run carries every stage, its verdicts, and a transcript per stage', () => {
  const stages = [
    stage({}),
    stage({ agent: 'review', model: 'claude-opus-5', verdict: 'request_changes', startedAt: '2026-10-19T05:32:00Z' }),
    stage({ round: 1, startedAt: '2026-10-19T05:35:00Z' }),
    stage({ agent: 'review', round: 1, model: 'claude-opus-5', verdict: 'approve', startedAt: '2026-10-19T05:38:00Z', transcript: 'withheld' }),
  ]
  const html = renderReport({
    generatedAt: '2026-10-19T06:00:00Z',
    rows: [row({ id: 'run-7', ...pr(7), task: 'json-export', verdict: 'approve', stages, costUsd: 1, outcome: 'open', humanTouches: 0 })],
    steps: {
      'run-7': {
        'implement-0': [{ kind: 'message', text: 'Added --json.' }],
        'review-0': [{ kind: 'message', text: 'Missing a test.\nVERDICT: request_changes' }],
        'implement-1': [{ kind: 'tool_call', tool: 'Edit', input: 'file_path: /work/test/export.test.ts' }],
        'review-1': null,
      },
    },
  })
  const data = JSON.parse(html.match(/id="report-data">([^<]*)</)![1])
  const run = data.rows[0]
  assert.equal(run.kind, 'implement')
  assert.equal(run.task, 'json-export')
  assert.equal(run.verdict, 'approve')
  assert.deepEqual(run.stages.map((s: StageRun) => [`${s.agent}-${s.round}`, s.verdict, s.transcript]), [
    ['implement-0', null, 'stored'],
    ['review-0', 'request_changes', 'stored'],
    ['implement-1', null, 'stored'],
    ['review-1', 'approve', 'withheld'],
  ])
  assert.match(data.steps['run-7']['review-0'][0].text, /VERDICT: request_changes/)
  assert.equal(data.steps['run-7']['implement-1'][0].tool, 'Edit')
  assert.equal(data.steps['run-7']['review-1'], null)
  assert.deepEqual(data.summary.byStatus, { pr_opened: 1 })
})

test('spec runs count under their own status', () => {
  const s = summarize([row({ kind: 'spec', status: 'spec_posted', costUsd: 0.2, stages: [stage({ agent: 'spec' })] }), row({ id: 'b', ...pr(2) })])
  assert.deepEqual(s.byStatus, { spec_posted: 1, pr_opened: 1 })
  assert.equal(s.prsOpened, 1)
})
