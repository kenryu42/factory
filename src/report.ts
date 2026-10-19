import { readFileSync } from 'node:fs'
import { benchSubject, CORRECTNESS, scoredRun } from './score.ts'
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

const tally = (passes: (boolean | null)[]): Tally =>
  ({ pass: passes.filter((p) => p === true).length, fail: passes.filter((p) => p === false).length, unknown: passes.filter((p) => p === null).length })
// Passes over graded subjects. null when none was graded.
export const passRate = (t: Tally) => (t.pass + t.fail ? t.pass / (t.pass + t.fail) : null)
const byScorer = (a: string, b: string) => Number(b === CORRECTNESS) - Number(a === CORRECTNESS) || a.localeCompare(b)

// Scorer -> implement harness -> how that harness's runs scored. Correctness comes first.
export function scoreSummary(rows: Pick<RunRecord, 'id' | 'harness'>[], scores: Score[]): { scorer: string; byHarness: Record<HarnessName, Tally> }[] {
  const harnessOf = new Map(rows.map((r) => [r.id, r.harness]))
  const names = [...new Set(scores.map((s) => s.scorer))].sort(byScorer)
  return names.map((scorer) => {
    const byHarness = Object.fromEntries(HARNESS_NAMES.map((h) => [h, { pass: 0, fail: 0, unknown: 0 }])) as Record<HarnessName, Tally>
    for (const s of scores) {
      const harness = harnessOf.get(scoredRun(s) ?? '')
      if (s.scorer !== scorer || !harness) continue
      byHarness[harness][s.pass === null ? 'unknown' : s.pass ? 'pass' : 'fail']++
    }
    return { scorer, byHarness }
  })
}

// The final review verdict against correctness, over runs that have both. approve.wrong counts defects the review missed.
export type Calibration = Record<Verdict, { correct: number; wrong: number }>

export function calibration(rows: Pick<RunRecord, 'id' | 'verdict'>[], scores: Score[]): Calibration {
  const correct = new Map(scores.filter((s) => s.scorer === CORRECTNESS && s.pass !== null).map((s) => [scoredRun(s), s.pass!]))
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
  // Judge scorer -> how this config's cells scored.
  judges: Record<string, Tally>
}

export type BenchSummary = { benchId: string; factoryRef: string; factorySha: string; baseSha: string; at: string; configs: BenchConfigSummary[] }

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

const configKey = (c: BenchResult) => `${c.harness}:${c.requestedModel}`

// Bench id -> cell -> scorer -> pass.
function cellScores(scores: Score[]): Map<string, Map<string, Map<string, boolean | null>>> {
  const out = new Map<string, Map<string, Map<string, boolean | null>>>()
  for (const s of scores) {
    if (s.subject.kind !== 'bench') continue
    const bench = out.get(s.subject.benchId) ?? out.set(s.subject.benchId, new Map()).get(s.subject.benchId)!
    const cell = bench.get(s.subject.cell) ?? bench.set(s.subject.cell, new Map()).get(s.subject.cell)!
    cell.set(s.scorer, s.pass)
  }
  return out
}

// Scorer -> tally over the given cells, for every judge that scored at least one of them.
function judgeTallies(cells: BenchResult[], scored: Map<string, Map<string, Map<string, boolean | null>>>): Record<string, Tally> {
  const mine = cells.map((c) => scored.get(c.benchId)?.get(benchSubject(c).cell) ?? new Map<string, boolean | null>())
  const names = [...new Set(mine.flatMap((m) => [...m.keys()]))].sort()
  return Object.fromEntries(names.map((n) => [n, tally(mine.filter((m) => m.has(n)).map((m) => m.get(n)!))]))
}

export function benchSummary(results: BenchResult[], scores: Score[]): BenchSummary[] {
  const scored = cellScores(scores)
  const byBench = Map.groupBy(results, (r) => r.benchId)
  return [...byBench].map(([benchId, cells]) => {
    const configs = [...Map.groupBy(cells, configKey).values()].map((mine): BenchConfigSummary => {
      const graded = mine.filter((c) => c.pass !== null)
      return {
        harness: mine[0].harness,
        model: mine[0].requestedModel,
        tasks: mine.length,
        passRate: graded.length ? graded.filter((c) => c.pass).length / graded.length : null,
        avgCostUsd: avg(mine.map((c) => c.costUsd).filter((c): c is number => c !== null)),
        avgWallTimeS: avg(mine.map((c) => c.wallTimeS))!,
        pareto: false,
        judges: judgeTallies(mine, scored),
      }
    })
    const plotted = configs.filter((c) => c.avgCostUsd !== null && c.passRate !== null)
    for (const i of paretoFrontier(plotted.map((c) => ({ costUsd: c.avgCostUsd!, passRate: c.passRate! })))) plotted[i].pareto = true
    const first = cells.reduce((a, b) => (a.at < b.at ? a : b))
    return { benchId, factoryRef: first.factoryRef, factorySha: first.factorySha, baseSha: first.baseSha, at: first.at, configs }
  }).sort((a, b) => b.at.localeCompare(a.at))
}

type BenchSide = { benchId: string; factoryRef: string; factorySha: string; at: string }

// Two benches run on different factory refs, compared over the tasks both ran under each config they share.
export type BenchComparison = {
  a: BenchSide
  b: BenchSide
  configs: {
    harness: HarnessName
    model: string
    tasks: number
    // Correctness first, then each judge that scored a shared cell. delta is B's pass rate minus A's, null when either is unknown.
    metrics: { scorer: string; a: Tally; b: Tally; delta: number | null }[]
    avgCostUsd: { a: number | null; b: number | null }
  }[]
}

// Every pair of benches on different factory refs that ran a task under a config in common. A is the bench on main when
// exactly one of them is, so an improvement branch is read against main; otherwise the older bench.
export function benchComparisons(results: BenchResult[], scores: Score[]): BenchComparison[] {
  const scored = cellScores(scores)
  const benches = [...Map.groupBy(results, (r) => r.benchId)].map(([benchId, cells]) => {
    const first = cells.reduce((x, y) => (x.at < y.at ? x : y))
    return { side: { benchId, factoryRef: first.factoryRef, factorySha: first.factorySha, at: first.at }, cells }
  }).sort((x, y) => x.side.at.localeCompare(y.side.at))
  const out: BenchComparison[] = []
  for (const [i, x] of benches.entries()) {
    for (const y of benches.slice(i + 1)) {
      if (x.side.factoryRef === y.side.factoryRef) continue
      const [a, b] = y.side.factoryRef === 'main' && x.side.factoryRef !== 'main' ? [y, x] : [x, y]
      const bCells = new Map(b.cells.map((c) => [`${configKey(c)} ${c.task}`, c]))
      const configs = [...Map.groupBy(a.cells.filter((c) => bCells.has(`${configKey(c)} ${c.task}`)), configKey).values()].map((aMine) => {
        const bMine = aMine.map((c) => bCells.get(`${configKey(c)} ${c.task}`)!)
        const aJudges = judgeTallies(aMine, scored)
        const bJudges = judgeTallies(bMine, scored)
        const metric = (scorer: string, ta: Tally, tb: Tally) => {
          const [ra, rb] = [passRate(ta), passRate(tb)]
          return { scorer, a: ta, b: tb, delta: ra === null || rb === null ? null : rb - ra }
        }
        const none = tally([])
        const judges = [...new Set([...Object.keys(aJudges), ...Object.keys(bJudges)])].sort()
        return {
          harness: aMine[0].harness,
          model: aMine[0].requestedModel,
          tasks: aMine.length,
          metrics: [
            metric(CORRECTNESS, tally(aMine.map((c) => c.pass)), tally(bMine.map((c) => c.pass))),
            ...judges.map((j) => metric(j, aJudges[j] ?? none, bJudges[j] ?? none)),
          ],
          avgCostUsd: {
            a: avg(aMine.map((c) => c.costUsd).filter((c): c is number => c !== null)),
            b: avg(bMine.map((c) => c.costUsd).filter((c): c is number => c !== null)),
          },
        }
      })
      if (configs.length) out.push({ a: a.side, b: b.side, configs })
    }
  }
  return out
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
    bench: benchSummary(model.bench, model.scores),
    comparisons: benchComparisons(model.bench, model.scores),
    improvements: model.improvements.toSorted((a, b) => b.at.localeCompare(a.at)),
  }
  // `<` escaped so no string in the data, such as `</script>` in a transcript, can end the script element.
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const template = readFileSync(new URL('./report.html', import.meta.url), 'utf8')
  return template.replace('__REPORT_DATA__', () => json)
}
