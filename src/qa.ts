import { spawnSync } from 'node:child_process'
import { COLOR_SCHEMES, type ColorScheme, type QaCheck, type QaConfig, type QaResult, type QaSummary, type Verdict } from './types.ts'

export const QA_CONFIG_PATH = '.factory/qa.json'
const KEYS = ['build', 'serve', 'url', 'pages', 'widths', 'schemes'] as const satisfies readonly (keyof QaConfig)[]

export function parseQaConfig(text: string): QaConfig {
  const fail = (why: string): never => {
    throw new Error(`${QA_CONFIG_PATH}: ${why}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return fail(`not valid JSON: ${(e as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('must be a JSON object')
  const o = raw as Record<string, unknown>
  const unknown = Object.keys(o).filter((k) => !(KEYS as readonly string[]).includes(k))
  if (unknown.length) fail(`unknown keys ${unknown.join(', ')}; the keys are ${KEYS.join(', ')}`)

  const command = (key: 'build' | 'serve') =>
    typeof o[key] === 'string' && o[key].trim() ? o[key] : fail(`${key} must be a non-empty shell command`)
  const list = <T>(key: 'pages' | 'widths' | 'schemes', ok: (v: unknown) => v is T, what: string): T[] => {
    const v = o[key]
    if (!Array.isArray(v) || v.length === 0) return fail(`${key} must be a non-empty array of ${what}`)
    const bad = v.filter((x) => !ok(x))
    if (bad.length) fail(`${key} must hold only ${what}, got ${bad.map((x) => JSON.stringify(x)).join(', ')}`)
    return v
  }

  let url: URL
  try {
    url = new URL(String(o.url))
  } catch {
    return fail(`url must be an http URL such as http://localhost:4321, got ${JSON.stringify(o.url)}`)
  }
  // The browser runs next to the server in the same container, so any other host would check a different site.
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/' || url.search) {
    fail(`url must be http://localhost:<port> or http://127.0.0.1:<port>, where serve listens, got ${JSON.stringify(o.url)}`)
  }

  return {
    build: command('build'),
    serve: command('serve'),
    url: url.origin,
    pages: list('pages', (p): p is string => typeof p === 'string' && p.startsWith('/'), 'paths starting with /'),
    widths: list('widths', (w): w is number => Number.isInteger(w) && (w as number) >= 200 && (w as number) <= 3840, 'whole pixel widths from 200 to 3840'),
    schemes: list('schemes', (s): s is ColorScheme => (COLOR_SCHEMES as readonly unknown[]).includes(s), COLOR_SCHEMES.join(' or ')),
  }
}

// The QA config at a commit. null when the repo has none there. QA always reads it from the base commit,
// so a change can never loosen the checks it is judged by.
export function qaConfigAt(repoDir: string, sha: string): QaConfig | null {
  const git = (...args: string[]) => spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' })
  const listed = git('ls-tree', '--name-only', sha, '--', QA_CONFIG_PATH)
  if (listed.status !== 0) throw new Error(`git ls-tree ${sha} failed: ${listed.stderr.trim()}`)
  if (!listed.stdout.trim()) return null
  return parseQaConfig(git('show', `${sha}:${QA_CONFIG_PATH}`).stdout)
}

const problems = (c: QaCheck) => [
  c.loadError && `did not load (${c.loadError})`,
  c.overflowPx > 0 && `overflow ${c.overflowPx}px`,
  c.consoleErrors.length > 0 && `${c.consoleErrors.length} console error${c.consoleErrors.length === 1 ? '' : 's'}`,
  c.failedRequests.length > 0 && `${c.failedRequests.length} failed request${c.failedRequests.length === 1 ? '' : 's'}`,
].filter((p): p is string => !!p)

// A check of the published tree next to the same check on the base commit. base is null when the base could not be checked.
export type QaRow = { check: QaCheck; base: QaCheck | null }

// The published tree's QA against the base commit's. A new failure's check keeps only the problems the base lacked,
// so a defect the change did not cause never blocks it.
export type QaComparison = { head: QaResult; base: QaResult; newFailures: QaRow[]; fixed: QaRow[]; stillFailing: QaRow[] }

const where = (c: QaCheck) => `${c.page} ${c.width} ${c.scheme}`

function added(check: QaCheck, base: QaCheck | null): QaCheck {
  if (!base) return check
  const errors = new Set(base.consoleErrors)
  const urls = new Set(base.failedRequests.map((f) => f.url))
  return {
    ...check,
    loadError: base.loadError ? null : check.loadError,
    overflowPx: base.overflowPx > 0 ? 0 : check.overflowPx,
    offenders: base.overflowPx > 0 ? [] : check.offenders,
    consoleErrors: check.consoleErrors.filter((e) => !errors.has(e)),
    failedRequests: check.failedRequests.filter((f) => !urls.has(f.url)),
  }
}

export function compareQa(base: QaResult, head: QaResult): QaComparison {
  const before = new Map(base.setupError ? [] : base.checks.map((c) => [where(c), c]))
  const q: QaComparison = { head, base, newFailures: [], fixed: [], stillFailing: [] }
  for (const check of head.checks) {
    const was = before.get(where(check)) ?? null
    const fresh = added(check, was)
    if (problems(fresh).length) q.newFailures.push({ check: fresh, base: was })
    else if (problems(check).length) q.stillFailing.push({ check, base: was })
    else if (was && problems(was).length) q.fixed.push({ check, base: was })
  }
  return q
}

export const qaFailed = (q: QaComparison) => q.head.setupError !== null || q.newFailures.length > 0

// The base screenshots worth keeping: those of the checks whose outcome the change moved.
export const baseShots = (q: QaComparison) =>
  [...q.newFailures, ...q.fixed].map((r) => r.base?.screenshot).filter((s): s is string => !!s)

export function summarizeQa(round: number, q: QaComparison): QaSummary {
  return {
    round,
    failed: qaFailed(q),
    setupError: q.head.setupError,
    baseSetupError: q.base.setupError,
    pages: new Set(q.head.checks.map((c) => c.page)).size,
    checks: q.head.checks.length,
    newFailures: q.newFailures.length,
    fixed: q.fixed.length,
    stillFailing: q.stillFailing.length,
  }
}

// New QA failures block approval whatever the review model said, so the revise round always sees them.
export function reviewVerdict(modelVerdict: Verdict | null, qa: QaComparison | null): Verdict | null {
  return qa && qaFailed(qa) ? 'request_changes' : modelVerdict
}

const MAX_ROWS = 30
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const inline = (s: string) => clip(s.replace(/\s+/g, ' ').trim(), 300).replaceAll('`', "'")

function headline(q: QaComparison): string {
  if (q.head.setupError) return `**QA failed**: it could not check any page. ${inline(q.head.setupError)}`
  const s = summarizeQa(0, q)
  const widths = [...new Set(q.head.checks.map((c) => c.width))].join(', ')
  const schemes = [...new Set(q.head.checks.map((c) => c.scheme))].join(' and ')
  const counts = `${s.newFailures} new failing, ${s.fixed} fixed, ${s.stillFailing} still failing as on the base commit`
  const noBase = q.base.setupError ? ` The base commit could not be checked, so every failure counts as new: ${inline(q.base.setupError)}` : ''
  return `**QA ${s.failed ? 'failed' : 'passed'}**: ${s.checks} checks of ${s.pages} pages at ${widths} px in ${schemes}: ${counts}.${noBase}`
}

function describe({ check: c, base }: QaRow, shots: string | null, withBase: boolean): string {
  const now = problems(c)
  const parts = [`- \`${c.page}\` at ${c.width}px ${c.scheme}: ${now.length ? now.join(', ') : `was ${problems(base!).join(', ')}`}.`]
  if (c.offenders.length) parts.push(`Sticks out: ${c.offenders.map((o) => `\`${o.element}\` "${inline(clip(o.text, 60))}" (right edge ${o.right}px)`).join('; ')}.`)
  for (const e of c.consoleErrors.slice(0, 3)) parts.push(`Console: \`${inline(e)}\`.`)
  for (const f of c.failedRequests.slice(0, 3)) parts.push(`${f.status} \`${inline(f.url)}\`.`)
  if (shots && c.screenshot) {
    const before = withBase && base?.screenshot ? `, on the base commit \`${shots}base/${base.screenshot}\`` : ''
    parts.push(`Screenshot: \`${shots}${c.screenshot}\`${before}.`)
  }
  return parts.join(' ')
}

function details(q: QaComparison, shots: string | null): string {
  if (q.head.setupError) return ''
  const cells = new Map([
    ...q.newFailures.map((r) => [where(r.check), `new: ${problems(r.check).join(', ')}`] as const),
    ...q.fixed.map((r) => [where(r.check), 'fixed'] as const),
    ...q.stillFailing.map((r) => [where(r.check), `still: ${problems(r.check).join(', ')}`] as const),
  ])
  const columns = [...new Map(q.head.checks.map((c) => [`${c.width} ${c.scheme}`, c])).keys()]
  const rows = [...Map.groupBy(q.head.checks, (c) => c.page)].map(([page, checks]) => {
    const cell = (col: string) => (checks.some((c) => `${c.width} ${c.scheme}` === col) ? (cells.get(`${page} ${col}`) ?? 'ok') : '')
    return `| \`${page}\` | ${columns.map(cell).join(' | ')} |`
  })
  const table = [`| Page | ${columns.join(' | ')} |`, `|---|${columns.map(() => '---').join('|')}|`, ...rows].join('\n')

  const group = (title: string, list: QaRow[], withBase: boolean) => {
    if (!list.length) return ''
    const lines = list.slice(0, MAX_ROWS).map((r) => describe(r, shots, withBase))
    if (list.length > MAX_ROWS) lines.push(`- and ${list.length - MAX_ROWS} more.`)
    return `### ${title}\n\n${lines.join('\n')}`
  }
  return [
    table,
    group('New failures, which block approval', q.newFailures, true),
    group('Fixed: failing on the base commit, passing now', q.fixed, true),
    group('Still failing as on the base commit, not blocking', q.stillFailing, false),
  ].filter(Boolean).join('\n\n')
}

// The QA report the review agent and the revise round read. shots prefixes each screenshot path; null leaves them out.
export function qaMarkdown(q: QaComparison, shots: string | null): string {
  return [`## Visual QA`, headline(q), details(q, shots)].filter(Boolean).join('\n\n') + '\n'
}

// The QA section of the PR comment: the headline, with the table and the failures folded away.
export function qaComment(q: QaComparison, shots: string): string {
  const body = details(q, shots)
  return [
    `### Visual QA`,
    headline(q) + (qaFailed(q) ? ' New QA failures block approval, so this round requests changes.' : ''),
    body && `<details><summary>Pages, widths and failures</summary>\n\n${body}\n\n</details>`,
  ].filter(Boolean).join('\n\n')
}
