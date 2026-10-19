import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseQaConfig, qaComment, qaConfigAt, qaMarkdown, reviewVerdict, summarizeQa } from '../src/qa.ts'
import type { QaCheck, QaResult } from '../src/types.ts'

const config = {
  build: 'bun install --frozen-lockfile && bun run build',
  serve: 'bun run start -- --port 4321 --host 0.0.0.0',
  url: 'http://localhost:4321',
  pages: ['/', '/cities/kobe-city/'],
  widths: [360, 1280],
  schemes: ['light', 'dark'],
}
const configText = (patch: Record<string, unknown> = {}) => JSON.stringify({ ...config, ...patch })

test('a valid qa.json parses into the config the QA runs', () => {
  assert.deepEqual(parseQaConfig(configText()), config)
})

test('a broken qa.json fails with a message naming the problem', () => {
  const { build, ...noBuild } = config
  assert.throws(() => parseQaConfig('{"build": '), /not valid JSON/)
  assert.throws(() => parseQaConfig('[]'), /must be a JSON object/)
  assert.throws(() => parseQaConfig(configText({ width: [360] })), /unknown keys width/)
  assert.throws(() => parseQaConfig(JSON.stringify(noBuild)), /build must be a non-empty shell command/)
  assert.throws(() => parseQaConfig(configText({ serve: '  ' })), /serve must be a non-empty shell command/)
  assert.throws(() => parseQaConfig(configText({ url: 'https://example.com' })), /url must be http:\/\/localhost/)
  assert.throws(() => parseQaConfig(configText({ url: 'localhost:4321' })), /url must be/)
  assert.throws(() => parseQaConfig(configText({ pages: [] })), /pages must be a non-empty array/)
  assert.throws(() => parseQaConfig(configText({ pages: ['/', 'cities/'] })), /pages must hold only paths starting with \/, got "cities\/"/)
  assert.throws(() => parseQaConfig(configText({ widths: [360, 12.5] })), /widths must hold only whole pixel widths/)
  assert.throws(() => parseQaConfig(configText({ schemes: ['dim'] })), /schemes must hold only light or dark, got "dim"/)
})

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-config-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  const commit = (files: Record<string, string | null>) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) rmSync(join(dir, file))
      else {
        mkdirSync(join(dir, file, '..'), { recursive: true })
        writeFileSync(join(dir, file), text)
      }
    }
    git('add', '-A')
    git('commit', '--quiet', '--allow-empty', '-m', 'c')
    return git('rev-parse', 'HEAD')
  }
  git('init', '--quiet')
  return { dir, commit }
}

test("the QA config comes from the base commit, so the agent's change cannot weaken it", () => {
  const { dir, commit } = repo()
  const base = commit({ '.factory/qa.json': configText(), 'index.html': '<h1>hi</h1>' })
  commit({ '.factory/qa.json': configText({ pages: ['/'], widths: [1280] }) })
  writeFileSync(join(dir, '.factory/qa.json'), configText({ pages: ['/404/'] }))
  assert.deepEqual(qaConfigAt(dir, base), config)
  const removed = commit({ '.factory/qa.json': null })
  assert.deepEqual(qaConfigAt(dir, base), config)
  assert.equal(qaConfigAt(dir, removed), null)
})

test('a repo that adds qa.json in the change itself gets no QA for that change', () => {
  const { dir, commit } = repo()
  const base = commit({ 'index.html': '<h1>hi</h1>' })
  commit({ '.factory/qa.json': configText() })
  assert.equal(qaConfigAt(dir, base), null)
})

const ok = (page: string, width: number, scheme: 'light' | 'dark'): QaCheck => ({
  page, width, scheme, loadError: null, overflowPx: 0, offenders: [], consoleErrors: [], failedRequests: [],
  screenshot: `${page.split('/').filter(Boolean).join('-') || 'index'}-${width}-${scheme}.png`,
})
const grid = (pages: string[]) => pages.flatMap((p) => [360, 1280].flatMap((w) => (['light', 'dark'] as const).map((s) => ok(p, w, s))))

test('a clean QA passes, and its report says so with no failures', () => {
  const result: QaResult = { url: 'http://localhost:4321', setupError: null, checks: grid(['/', '/cities/']) }
  assert.deepEqual(summarizeQa(0, result), {
    round: 0, failed: false, setupError: null, pages: 2, checks: 8, overflow: 0, consoleErrors: 0, failedRequests: 0, loadErrors: 0,
  })
  const md = qaMarkdown(result, '/input/qa/')
  assert.match(md, /\*\*QA passed\*\*: 8 checks of 2 pages at 360, 1280 px in light and dark/)
  assert.match(md, /\| `\/cities\/` \| ok \| ok \| ok \| ok \|/)
  assert.doesNotMatch(md, /Failures/)
  assert.equal(reviewVerdict('approve', result), 'approve')
})

test('overflow and console errors fail the QA, and the report names the offenders and screenshots', () => {
  const checks = grid(['/', '/cities/kobe-city/'])
  const wide = checks.find((c) => c.page === '/cities/kobe-city/' && c.width === 360 && c.scheme === 'dark')!
  Object.assign(wide, { overflowPx: 34, offenders: [{ element: 'span.chip', text: '住民戸籍課 Resident and Family Register Division', right: 394 }] })
  const broken = checks.find((c) => c.page === '/' && c.width === 1280 && c.scheme === 'light')!
  broken.consoleErrors = ['TypeError: x is undefined']
  broken.failedRequests = [{ url: 'http://localhost:4321/data.json', status: 404 }]
  const result: QaResult = { url: 'http://localhost:4321', setupError: null, checks }

  assert.deepEqual(summarizeQa(1, result), {
    round: 1, failed: true, setupError: null, pages: 2, checks: 8, overflow: 1, consoleErrors: 1, failedRequests: 1, loadErrors: 0,
  })
  const md = qaMarkdown(result, '/input/qa/')
  assert.match(md, /\*\*QA failed\*\*: 8 checks of 2 pages .*: 1 scroll sideways, 1 have console errors, 1 have failed requests, 0 did not load\./)
  assert.match(md, /\| `\/cities\/kobe-city\/` \| ok \| overflow 34px \| ok \| ok \|/)
  assert.match(md, /- `\/cities\/kobe-city\/` at 360px dark: overflow 34px\. Sticks out: `span\.chip` "住民戸籍課 Resident and Family Register Division" \(right edge 394px\)\. Screenshot: `\/input\/qa\/cities-kobe-city-360-dark\.png`\./)
  assert.match(md, /- `\/` at 1280px light: 1 console error, 1 failed request\. Console: `TypeError: x is undefined`\. 404 `http:\/\/localhost:4321\/data\.json`\./)
  assert.doesNotMatch(qaMarkdown(result, null), /Screenshot:/)
  assert.match(qaComment(result, 'qa/run-1/0/screenshots/'), /QA failures block approval, so this round requests changes\.\n\n<details>[\s\S]*`qa\/run-1\/0\/screenshots\/cities-kobe-city-360-dark\.png`[\s\S]*<\/details>$/)
})

test('a failing QA forces request_changes whatever the review model said', () => {
  const result: QaResult = { url: 'http://localhost:4321', setupError: null, checks: grid(['/']) }
  result.checks[0].overflowPx = 12
  assert.equal(reviewVerdict('approve', result), 'request_changes')
  assert.equal(reviewVerdict(null, result), 'request_changes')
  assert.equal(reviewVerdict('approve', null), 'approve')
  assert.equal(reviewVerdict(null, null), null)
})

test('a build that fails is a QA failure that says why', () => {
  const result: QaResult = { url: 'http://localhost:4321', setupError: 'build exited with 1:\nerror: lockfile had changes', checks: [] }
  assert.equal(summarizeQa(0, result).failed, true)
  assert.equal(reviewVerdict('approve', result), 'request_changes')
  assert.equal(qaMarkdown(result, '/input/qa/'), '## Visual QA\n\n**QA failed**: it could not check any page. build exited with 1: error: lockfile had changes\n')
})
