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

export const qaFailed = (r: QaResult) => r.setupError !== null || r.checks.some((c) => problems(c).length > 0)

export function summarizeQa(round: number, r: QaResult): QaSummary {
  const count = (pick: (c: QaCheck) => boolean) => r.checks.filter(pick).length
  return {
    round,
    failed: qaFailed(r),
    setupError: r.setupError,
    pages: new Set(r.checks.map((c) => c.page)).size,
    checks: r.checks.length,
    overflow: count((c) => c.overflowPx > 0),
    consoleErrors: count((c) => c.consoleErrors.length > 0),
    failedRequests: count((c) => c.failedRequests.length > 0),
    loadErrors: count((c) => c.loadError !== null),
  }
}

// A failing QA blocks approval whatever the review model said, so the revise round always sees the failures.
export function reviewVerdict(modelVerdict: Verdict | null, qa: QaResult | null): Verdict | null {
  return qa && qaFailed(qa) ? 'request_changes' : modelVerdict
}

const MAX_FAILURES = 30
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const inline = (s: string) => clip(s.replace(/\s+/g, ' ').trim(), 300).replaceAll('`', "'")

function headline(r: QaResult): string {
  if (r.setupError) return `**QA failed**: it could not check any page. ${inline(r.setupError)}`
  const s = summarizeQa(0, r)
  const widths = [...new Set(r.checks.map((c) => c.width))].join(', ')
  const schemes = [...new Set(r.checks.map((c) => c.scheme))].join(' and ')
  const counts = `${s.overflow} scroll sideways, ${s.consoleErrors} have console errors, ${s.failedRequests} have failed requests, ${s.loadErrors} did not load`
  return `**QA ${s.failed ? 'failed' : 'passed'}**: ${s.checks} checks of ${s.pages} pages at ${widths} px in ${schemes}: ${counts}.`
}

function details(r: QaResult, shots: string | null): string {
  if (r.setupError) return ''
  const columns = [...new Map(r.checks.map((c) => [`${c.width} ${c.scheme}`, c])).keys()]
  const rows = [...Map.groupBy(r.checks, (c) => c.page)].map(([page, checks]) => {
    const cell = (col: string) => {
      const c = checks.find((x) => `${x.width} ${x.scheme}` === col)
      return c ? problems(c).join(', ') || 'ok' : ''
    }
    return `| \`${page}\` | ${columns.map(cell).join(' | ')} |`
  })
  const table = [`| Page | ${columns.join(' | ')} |`, `|---|${columns.map(() => '---').join('|')}|`, ...rows].join('\n')

  const failing = r.checks.filter((c) => problems(c).length > 0)
  const lines = failing.slice(0, MAX_FAILURES).map((c) => {
    const parts = [`- \`${c.page}\` at ${c.width}px ${c.scheme}: ${problems(c).join(', ')}.`]
    if (c.offenders.length) parts.push(`Sticks out: ${c.offenders.map((o) => `\`${o.element}\` "${inline(clip(o.text, 60))}" (right edge ${o.right}px)`).join('; ')}.`)
    for (const e of c.consoleErrors.slice(0, 3)) parts.push(`Console: \`${inline(e)}\`.`)
    for (const f of c.failedRequests.slice(0, 3)) parts.push(`${f.status} \`${inline(f.url)}\`.`)
    if (shots && c.screenshot) parts.push(`Screenshot: \`${shots}${c.screenshot}\`.`)
    return parts.join(' ')
  })
  if (failing.length > MAX_FAILURES) lines.push(`- and ${failing.length - MAX_FAILURES} more failing checks.`)
  return [table, lines.length ? `### Failures\n\n${lines.join('\n')}` : ''].filter(Boolean).join('\n\n')
}

// The QA report the review agent and the revise round read. shots prefixes each screenshot path; null leaves them out.
export function qaMarkdown(r: QaResult, shots: string | null): string {
  return [`## Visual QA`, headline(r), details(r, shots)].filter(Boolean).join('\n\n') + '\n'
}

// The QA section of the PR comment: the headline, with the table and failures folded away.
export function qaComment(r: QaResult, shots: string): string {
  const failed = qaFailed(r)
  const body = details(r, shots)
  return [
    `### Visual QA`,
    headline(r) + (failed ? ' QA failures block approval, so this round requests changes.' : ''),
    body && `<details><summary>Pages, widths and failures</summary>\n\n${body}\n\n</details>`,
  ].filter(Boolean).join('\n\n')
}
