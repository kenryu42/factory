import { readFileSync } from 'node:fs'
import { HARNESS_NAMES, type HarnessName, type Outcome, type ReportRow, type RunStatus, type Step } from './types.ts'

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

export type ReportModel = {
  generatedAt: string
  rows: ReportRow[]
  // null when the transcript was withheld or is missing.
  steps: Record<string, Step[] | null>
}

export function renderReport(model: ReportModel): string {
  const steps = Object.fromEntries(Object.entries(model.steps).map(([id, s]) => [id, s && s.map(clipStep)]))
  const data = { ...model, steps, summary: summarize(model.rows) }
  // `<` escaped so no string in the data, such as `</script>` in a transcript, can end the script element.
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const template = readFileSync(new URL('./report.html', import.meta.url), 'utf8')
  return template.replace('__REPORT_DATA__', () => json)
}
