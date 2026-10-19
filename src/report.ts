import { readFileSync } from 'node:fs'
import { CORRECTNESS } from './score.ts'
import { HARNESS_NAMES, type BenchResult, type HarnessName, type Improvement, type Outcome, type ReportRow, type RunRecord, type RunStatus, type Score, type Step, type Verdict } from './types.ts'

const MAX_INPUT = 2000
const MAX_OUTPUT = 4000

type Author = { login: string } | null

// The fields of `gh pr view --json state,mergedAt,comments,reviews,commits` that the report reads.
export type PrView = {
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  mergedAt: string | null
  comments: { author: Author }[]
  reviews: { author: Author }[]
  commits: { authors: { login: string }[] }[]
}

// Bots can't be told apart by login in this payload and the factory commits without one,
// so only the repo owner's comments, reviews and commits count as human touches.
export function prOutcome(repo: string, pr: PrView, revertFound: boolean): { outcome: Outcome; humanTouches: number } {
  const owner = repo.split('/')[0].toLowerCase()
  const isOwner = (login: string | undefined) => login?.toLowerCase() === owner
  const humanTouches =
    pr.comments.filter((c) => isOwner(c.author?.login)).length +
    pr.reviews.filter((r) => isOwner(r.author?.login)).length +
    pr.commits.filter((c) => c.authors.some((a) => isOwner(a.login))).length
  const outcome: Outcome = pr.state === 'MERGED' ? (revertFound ? 'reverted' : 'merged') : pr.state === 'CLOSED' ? 'closed' : 'open'
  return { outcome, humanTouches }
}

export type Summary = {
  runs: number
  prsOpened: number
  totalCostUsd: number
  costPerPrUsd: number | null
  // Every PR that was merged, including the ones later reverted.
  merged: number
  reverted: number
  avgHumanTouches: number | null
  byStatus: Partial<Record<RunStatus, number>>
  // costUsd is null when no run on that harness reported a price.
  byHarness: Record<HarnessName, { runs: number; costUsd: number | null }>
}

export function summarize(rows: ReportRow[]): Summary {
  const costs = rows.map((r) => r.costUsd).filter((c): c is number => c !== null)
  const totalCostUsd = costs.reduce((a, b) => a + b, 0)
  const prsOpened = rows.filter((r) => r.prUrl !== null).length
  const touches = rows.filter((r) => r.prUrl !== null && r.humanTouches !== null).map((r) => r.humanTouches!)
  const byStatus: Summary['byStatus'] = {}
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
  const byHarness = Object.fromEntries(HARNESS_NAMES.map((h) => {
    const mine = rows.filter((r) => r.harness === h)
    const priced = mine.map((r) => r.costUsd).filter((c): c is number => c !== null)
    return [h, { runs: mine.length, costUsd: priced.length ? priced.reduce((a, b) => a + b, 0) : null }]
  })) as Summary['byHarness']
  return {
    runs: rows.length,
    prsOpened,
    totalCostUsd,
    costPerPrUsd: prsOpened ? totalCostUsd / prsOpened : null,
    merged: rows.filter((r) => r.outcome === 'merged' || r.outcome === 'reverted').length,
    reverted: rows.filter((r) => r.outcome === 'reverted').length,
    avgHumanTouches: touches.length ? touches.reduce((a, b) => a + b, 0) / touches.length : null,
    byStatus,
    byHarness,
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[${text.length - max} more characters cut]` : text)

function clipStep(s: Step): Step {
  if (s.kind === 'tool_call') return { ...s, input: clip(s.input, MAX_INPUT) }
  if (s.kind === 'tool_result') return { ...s, output: clip(s.output, MAX_OUTPUT) }
  return s
}

export type Tally = { pass: number; fail: number; unknown: number }

// Scorer -> implement harness -> how that harness's runs scored. Correctness comes first.
export function scoreSummary(rows: Pick<RunRecord, 'id' | 'harness'>[], scores: Score[]): { scorer: string; byHarness: Record<HarnessName, Tally> }[] {
  const harnessOf = new Map(rows.map((r) => [r.id, r.harness]))
  const names = [...new Set(scores.map((s) => s.scorer))].sort((a, b) => Number(b === CORRECTNESS) - Number(a === CORRECTNESS) || a.localeCompare(b))
  return names.map((scorer) => {
    const byHarness = Object.fromEntries(HARNESS_NAMES.map((h) => [h, { pass: 0, fail: 0, unknown: 0 }])) as Record<HarnessName, Tally>
    for (const s of scores) {
      const harness = harnessOf.get(s.runId)
      if (s.scorer !== scorer || !harness) continue
      byHarness[harness][s.pass === null ? 'unknown' : s.pass ? 'pass' : 'fail']++
    }
    return { scorer, byHarness }
  })
}

// The final review verdict against correctness, over runs that have both. approve.wrong counts defects the review missed.
export type Calibration = Record<Verdict, { correct: number; wrong: number }>

export function calibration(rows: Pick<RunRecord, 'id' | 'verdict'>[], scores: Score[]): Calibration {
  const correct = new Map(scores.filter((s) => s.scorer === CORRECTNESS && s.pass !== null).map((s) => [s.runId, s.pass!]))
  const cal: Calibration = { approve: { correct: 0, wrong: 0 }, request_changes: { correct: 0, wrong: 0 } }
  for (const r of rows) {
    const pass = correct.get(r.id)
    if (r.verdict && pass !== undefined) cal[r.verdict][pass ? 'correct' : 'wrong']++
  }
  return cal
}

// Indexes of the points no other point beats: none is at most as costly and at least as good, and better on one.
export function paretoFrontier(points: { costUsd: number; passRate: number }[]): number[] {
  return points.flatMap((p, i) => points.some((q) =>
    q.costUsd <= p.costUsd && q.passRate >= p.passRate && (q.costUsd < p.costUsd || q.passRate > p.passRate)) ? [] : [i])
}

export type BenchConfigSummary = {
  harness: HarnessName
  model: string
  tasks: number
  // Over tasks with a check. null when no task had one.
  passRate: number | null
  // Averages over the tasks that reported them.
  avgCostUsd: number | null
  avgWallTimeS: number
  pareto: boolean
}

export type BenchSummary = { benchId: string; factoryRef: string; factorySha: string; baseSha: string; at: string; configs: BenchConfigSummary[] }

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

export function benchSummary(results: BenchResult[]): BenchSummary[] {
  const byBench = Map.groupBy(results, (r) => r.benchId)
  return [...byBench].map(([benchId, cells]) => {
    const configs = [...Map.groupBy(cells, (c) => `${c.harness}:${c.requestedModel}`).values()].map((mine): BenchConfigSummary => {
      const graded = mine.filter((c) => c.pass !== null)
      return {
        harness: mine[0].harness,
        model: mine[0].requestedModel,
        tasks: mine.length,
        passRate: graded.length ? graded.filter((c) => c.pass).length / graded.length : null,
        avgCostUsd: avg(mine.map((c) => c.costUsd).filter((c): c is number => c !== null)),
        avgWallTimeS: avg(mine.map((c) => c.wallTimeS))!,
        pareto: false,
      }
    })
    const plotted = configs.filter((c) => c.avgCostUsd !== null && c.passRate !== null)
    for (const i of paretoFrontier(plotted.map((c) => ({ costUsd: c.avgCostUsd!, passRate: c.passRate! })))) plotted[i].pareto = true
    const first = cells.reduce((a, b) => (a.at < b.at ? a : b))
    return { benchId, factoryRef: first.factoryRef, factorySha: first.factorySha, baseSha: first.baseSha, at: first.at, configs }
  }).sort((a, b) => b.at.localeCompare(a.at))
}

export type ReportModel = {
  generatedAt: string
  rows: ReportRow[]
  // Run id -> stage (`<agent>-<round>`) -> steps. null when the transcript was withheld or is missing.
  steps: Record<string, Record<string, Step[] | null>>
  scores: Score[]
  bench: BenchResult[]
  // headline is the first line of the agent's summary, null when none was stored.
  improvements: (Improvement & { headline: string | null })[]
}

export function renderReport(model: ReportModel): string {
  const steps = Object.fromEntries(Object.entries(model.steps).map(([id, stages]) =>
    [id, Object.fromEntries(Object.entries(stages).map(([stage, s]) => [stage, s && s.map(clipStep)]))]))
  const data = {
    generatedAt: model.generatedAt,
    rows: model.rows,
    steps,
    scores: model.scores,
    summary: summarize(model.rows),
    scoreSummary: scoreSummary(model.rows, model.scores),
    calibration: calibration(model.rows, model.scores),
    bench: benchSummary(model.bench),
    improvements: model.improvements.toSorted((a, b) => b.at.localeCompare(a.at)),
  }
  // `<` escaped so no string in the data, such as `</script>` in a transcript, can end the script element.
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const template = readFileSync(new URL('./report.html', import.meta.url), 'utf8')
  return template.replace('__REPORT_DATA__', () => json)
}
