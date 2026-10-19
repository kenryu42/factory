import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { benchSummary, calibration, paretoFrontier, prOutcome, renderReport, scoreSummary, summarize, type PrView } from '../src/report.ts'
import type { BenchResult, ReportRow, Score, StageRun } from '../src/types.ts'

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
    scores: [],
    bench: [],
    improvements: [],
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
    scores: [],
    bench: [],
    improvements: [],
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
    scores: [],
    bench: [],
    improvements: [],
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

function score(runId: string, scorer: string, pass: boolean | null): Score {
  return {
    runId, scorer, pass, reason: pass === null ? 'The judge did not finish.' : 'ℹ pass 10', sha: 'c535f0b', factorySha: 'f', at: '2026-10-19T12:00:00Z',
    judge: scorer === 'correctness' ? null : { harness: 'pi', model: 'deepseek/deepseek-v4-flash', billing: 'api', costUsd: 0.002, wallTimeS: 20 },
  }
}

test('pass rates per scorer are split by the implement harness, unknown kept apart', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c', harness: 'pi' })]
  const scores = [
    score('a', 'scope', true), score('b', 'scope', false), score('c', 'scope', null),
    score('a', 'correctness', true), score('c', 'correctness', true),
    score('gone', 'correctness', false),
  ]
  assert.deepEqual(scoreSummary(rows, scores), [
    { scorer: 'correctness', byHarness: { 'claude-code': { pass: 1, fail: 0, unknown: 0 }, pi: { pass: 1, fail: 0, unknown: 0 } } },
    { scorer: 'scope', byHarness: { 'claude-code': { pass: 1, fail: 1, unknown: 0 }, pi: { pass: 0, fail: 0, unknown: 1 } } },
  ])
})

test('review calibration crosses the final verdict with correctness', () => {
  const rows = [
    row({ id: 'ok', verdict: 'approve' }),
    row({ id: 'missed', verdict: 'approve' }),
    row({ id: 'missed-2', verdict: 'approve' }),
    row({ id: 'caught', verdict: 'request_changes' }),
    row({ id: 'no-verdict', verdict: null }),
    row({ id: 'ungraded', verdict: 'approve' }),
  ]
  const scores = [
    score('ok', 'correctness', true), score('missed', 'correctness', false), score('missed-2', 'correctness', false),
    score('caught', 'correctness', false), score('no-verdict', 'correctness', true), score('ungraded', 'correctness', null),
    score('ok', 'scope', false),
  ]
  assert.deepEqual(calibration(rows, scores), { approve: { correct: 1, wrong: 2 }, request_changes: { correct: 0, wrong: 1 } })
})

test('the Pareto frontier keeps every config that no other is both cheaper and better than', () => {
  const points = [
    { costUsd: 0.01, passRate: 0.5 },
    { costUsd: 0.05, passRate: 0.9 },
    { costUsd: 0.04, passRate: 0.5 },
    { costUsd: 0.2, passRate: 0.9 },
    { costUsd: 0.3, passRate: 1 },
    { costUsd: 0.01, passRate: 0.5 },
  ]
  assert.deepEqual(paretoFrontier(points), [0, 1, 4, 5])
  assert.deepEqual(paretoFrontier([]), [])
})

function cell(over: Partial<BenchResult>): BenchResult {
  return {
    benchId: 'b1', task: 'negative-money', harness: 'pi', requestedModel: 'deepseek/deepseek-v4-flash', model: 'deepseek/deepseek-v4-flash',
    factoryRef: 'main', factorySha: '844065abe6575eaedda591277ce42e62d8b45126', baseSha: '226c94b271c2171da2bfdeac39542313240dea84', billing: 'api',
    pass: true, checkOutput: 'ℹ pass 10', usage: { inputTokens: 4451, cacheReadTokens: 25600, outputTokens: 1395, costUsd: 0.01 }, costUsd: 0.01,
    wallTimeS: 20, at: '2026-10-19T12:00:00Z', transcript: 'stored', ...over,
  }
}

test('bench summary: pass rate over graded tasks, average cost and time, and the frontier per config', () => {
  const haiku = { harness: 'claude-code' as const, requestedModel: 'haiku', model: 'claude-haiku-5-5' }
  const sonnet = { harness: 'claude-code' as const, requestedModel: 'sonnet', model: 'claude-sonnet-5-5' }
  const [b1] = benchSummary([
    cell({ task: 'negative-money', costUsd: 0.01, wallTimeS: 20 }),
    cell({ task: 'recurring', pass: false, costUsd: 0.03, wallTimeS: 40 }),
    cell({ task: 'no-check', pass: null, costUsd: 0.02, wallTimeS: 30 }),
    cell({ ...haiku, task: 'negative-money', costUsd: 0.05 }),
    cell({ ...haiku, task: 'recurring', pass: false, costUsd: null }),
    cell({ ...sonnet, task: 'negative-money', costUsd: 0.3 }),
    cell({ ...sonnet, task: 'recurring', costUsd: 0.5 }),
  ])
  const byConfig = Object.fromEntries(b1.configs.map((c) => [`${c.harness}:${c.model}`, c]))
  assert.equal(byConfig['pi:deepseek/deepseek-v4-flash'].tasks, 3)
  assert.equal(byConfig['pi:deepseek/deepseek-v4-flash'].passRate, 0.5)
  assert.ok(Math.abs(byConfig['pi:deepseek/deepseek-v4-flash'].avgCostUsd! - 0.02) < 1e-12)
  assert.equal(byConfig['pi:deepseek/deepseek-v4-flash'].avgWallTimeS, 30)
  assert.equal(byConfig['claude-code:haiku'].avgCostUsd, 0.05, 'an unpriced task does not count as free')
  assert.deepEqual(b1.configs.map((c) => [`${c.harness}:${c.model}`, c.pareto]), [
    ['pi:deepseek/deepseek-v4-flash', true],
    ['claude-code:haiku', false],
    ['claude-code:sonnet', true],
  ])
  assert.equal(b1.factoryRef, 'main')
})

test('benches are kept apart and the newest comes first', () => {
  const summaries = benchSummary([cell({ benchId: 'old', at: '2026-10-01T00:00:00Z' }), cell({ benchId: 'new', at: '2026-10-19T00:00:00Z' })])
  assert.deepEqual(summaries.map((b) => [b.benchId, b.configs.length]), [['new', 1], ['old', 1]])
})

test('the page carries each run score and the bench summary', () => {
  const html = renderReport({
    generatedAt: '2026-10-19T06:00:00Z',
    rows: [row({ id: 'run-1', verdict: 'approve' })],
    steps: {},
    scores: [score('run-1', 'correctness', false), score('run-1', 'scope', true)],
    bench: [cell({})],
    improvements: [],
  })
  const data = JSON.parse(html.match(/id="report-data">([^<]*)</)![1])
  assert.deepEqual(data.scores.map((s: Score) => [s.runId, s.scorer, s.pass]), [['run-1', 'correctness', false], ['run-1', 'scope', true]])
  assert.deepEqual(data.calibration.approve, { correct: 0, wrong: 1 })
  assert.equal(data.bench[0].configs[0].passRate, 1)
})
