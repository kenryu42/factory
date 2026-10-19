import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseShots, compareQa, parseQaConfig, qaComment, qaConfigAt, qaMarkdown, reviewVerdict, summarizeQa } from '../src/qa.ts'
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
  screenshot: `${page.split('/').filter(Boolean).join('-') || 'index'}-${width}-${scheme}.jpg`,
})
const grid = (pages: string[]) => pages.flatMap((p) => [360, 1280].flatMap((w) => (['light', 'dark'] as const).map((s) => ok(p, w, s))))
const result = (checks: QaCheck[], setupError: string | null = null): QaResult => ({ url: 'http://localhost:4321', setupError, checks })
const at = (r: QaResult, page: string, width: number, scheme: string) => r.checks.find((c) => c.page === page && c.width === width && c.scheme === scheme)!
const chip = { element: 'span.chip', text: '住民戸籍課 Resident and Family Register Division', right: 394 }

test('a clean QA passes, and its report says so with no failures', () => {
  const qa = compareQa(result(grid(['/', '/cities/'])), result(grid(['/', '/cities/'])))
  assert.deepEqual(summarizeQa(0, qa), {
    round: 0, failed: false, setupError: null, baseSetupError: null, pages: 2, checks: 8, newFailures: 0, fixed: 0, stillFailing: 0,
  })
  const md = qaMarkdown(qa, '/input/qa/')
  assert.match(md, /\*\*QA passed\*\*: 8 checks of 2 pages at 360, 1280 px in light and dark: 0 new failing, 0 fixed, 0 still failing as on the base commit\./)
  assert.match(md, /\| `\/cities\/` \| ok \| ok \| ok \| ok \|/)
  assert.doesNotMatch(md, /###/)
  assert.equal(reviewVerdict('approve', qa), 'approve')
})

test('the QA sorts failures into new, fixed and still failing against the base commit', () => {
  const base = result(grid(['/', '/cities/kobe-city/']))
  const head = result(grid(['/', '/cities/kobe-city/']))
  Object.assign(at(base, '/', 360, 'light'), { overflowPx: 40, offenders: [chip] })
  for (const r of [base, head]) Object.assign(at(r, '/cities/kobe-city/', 360, 'dark'), { overflowPx: 34, offenders: [chip] })
  at(head, '/', 1280, 'light').consoleErrors = ['TypeError: x is undefined']
  at(base, '/cities/kobe-city/', 1280, 'dark').failedRequests = [{ url: 'http://localhost:4321/old.json', status: 404 }]
  at(head, '/cities/kobe-city/', 1280, 'dark').failedRequests = [
    { url: 'http://localhost:4321/old.json', status: 404 },
    { url: 'http://localhost:4321/data.json', status: 500 },
  ]
  const qa = compareQa(base, head)

  assert.deepEqual(summarizeQa(1, qa), {
    round: 1, failed: true, setupError: null, baseSetupError: null, pages: 2, checks: 8, newFailures: 2, fixed: 1, stillFailing: 1,
  })
  const md = qaMarkdown(qa, '/input/qa/')
  assert.match(md, /\*\*QA failed\*\*: 8 checks of 2 pages .*: 2 new failing, 1 fixed, 1 still failing as on the base commit\./)
  assert.match(md, /\| `\/` \| fixed \| ok \| new: 1 console error \| ok \|/)
  assert.match(md, /\| `\/cities\/kobe-city\/` \| ok \| still: overflow 34px \| ok \| new: 1 failed request \|/)
  const section = (title: string) => md.split('### ').find((s) => s.startsWith(title))!
  assert.match(section('New failures'), /- `\/` at 1280px light: 1 console error\. Console: `TypeError: x is undefined`\. Screenshot: `\/input\/qa\/index-1280-light\.jpg`, on the base commit `\/input\/qa\/base\/index-1280-light\.jpg`\./)
  assert.match(section('New failures'), /- `\/cities\/kobe-city\/` at 1280px dark: 1 failed request\. 500 `http:\/\/localhost:4321\/data\.json`\. Screenshot/)
  assert.doesNotMatch(section('New failures'), /old\.json/)
  assert.match(section('Fixed'), /- `\/` at 360px light: was overflow 40px\. Screenshot: `\/input\/qa\/index-360-light\.jpg`, on the base commit `\/input\/qa\/base\/index-360-light\.jpg`\./)
  assert.match(section('Still failing'), /- `\/cities\/kobe-city\/` at 360px dark: overflow 34px\. Sticks out: `span\.chip` "住民戸籍課 Resident and Family Register Division" \(right edge 394px\)\. Screenshot: `\/input\/qa\/cities-kobe-city-360-dark\.jpg`\.\n/)
  assert.deepEqual(baseShots(qa).sort(), ['cities-kobe-city-1280-dark.jpg', 'index-1280-light.jpg', 'index-360-light.jpg'])
  assert.doesNotMatch(qaMarkdown(qa, null), /Screenshot:/)
  assert.match(qaComment(qa, 'qa/run-1/1/screenshots/'), /New QA failures block approval, so this round requests changes\.\n\n<details>[\s\S]*`qa\/run-1\/1\/screenshots\/base\/index-360-light\.jpg`[\s\S]*<\/details>$/)
})

test('only new failures force request_changes; failures already on the base commit do not', () => {
  const base = result(grid(['/']))
  const head = result(grid(['/']))
  for (const r of [base, head]) Object.assign(r.checks[0], { overflowPx: 12, consoleErrors: ['Hydration failed'] })
  const preexisting = compareQa(base, head)
  assert.equal(summarizeQa(0, preexisting).failed, false)
  assert.equal(reviewVerdict('approve', preexisting), 'approve')
  assert.doesNotMatch(qaComment(preexisting, 'shots/'), /block approval/)

  head.checks[1].overflowPx = 8
  const regressed = compareQa(base, head)
  assert.equal(reviewVerdict('approve', regressed), 'request_changes')
  assert.equal(reviewVerdict(null, regressed), 'request_changes')
  assert.equal(reviewVerdict('approve', null), 'approve')
  assert.equal(reviewVerdict(null, null), null)
})

test('a published tree that fails to build blocks approval, whatever the base did', () => {
  const head = result([], 'build exited with 1:\nerror: lockfile had changes')
  for (const base of [result(grid(['/'])), result([], 'build exited with 1')]) {
    const qa = compareQa(base, head)
    assert.equal(summarizeQa(0, qa).failed, true)
    assert.equal(reviewVerdict('approve', qa), 'request_changes')
    assert.equal(qaMarkdown(qa, '/input/qa/'), '## Visual QA\n\n**QA failed**: it could not check any page. build exited with 1: error: lockfile had changes\n')
  }
})

test('a base commit that fails to build blocks nothing itself, and every failure of the published tree counts as new', () => {
  const base = result([], 'build exited with 1:\nerror: missing module')
  const clean = compareQa(base, result(grid(['/'])))
  assert.deepEqual(summarizeQa(0, clean), {
    round: 0, failed: false, setupError: null, baseSetupError: 'build exited with 1:\nerror: missing module', pages: 1, checks: 4, newFailures: 0, fixed: 0, stillFailing: 0,
  })
  assert.match(qaMarkdown(clean, null), /The base commit could not be checked, so every failure counts as new: build exited with 1: error: missing module/)

  const head = result(grid(['/']))
  head.checks[0].overflowPx = 12
  assert.equal(summarizeQa(0, compareQa(base, head)).newFailures, 1)
  assert.equal(reviewVerdict('approve', compareQa(base, head)), 'request_changes')
})

// A revise run's base is the merge base of an older pull request, which can predate qa.json on the default branch.
test('a revise run gets QA, with the config from the default branch', () => {
  const { dir: origin, commit } = repo()
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  const base = commit({ 'index.html': '<h1>hi</h1>' })
  git(origin, 'branch', 'factory/issue-1-x')
  commit({ '.factory/qa.json': configText() })
  git(origin, 'checkout', '--quiet', 'factory/issue-1-x')
  const head = commit({ 'index.html': '<h1>hello</h1>' })
  const run = mkdtempSync(join(tmpdir(), 'qa-revise-'))
  git(run, 'clone', '--quiet', origin, 'pub')
  git(join(run, 'pub'), 'checkout', '--quiet', head)
  writeFileSync(join(run, 'plan.json'), JSON.stringify({ kind: 'revise', baseBranch: 'main', issue: { repo: 'o/r', number: 1, title: 't', body: '' } }))
  writeFileSync(join(run, 'implement-0.json'), JSON.stringify({ baseSha: base }))
  writeFileSync(join(run, 'publish-0.json'), JSON.stringify({ status: 'pr_updated', sha: head }))
  const bin = join(run, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "no docker in this test" >&2\nexit 1\n', { mode: 0o755 })
  const out = execFileSync('node', [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'qa', '0'], {
    encoding: 'utf8',
    env: { ...process.env, FACTORY_RUN_DIR: run, PATH: `${bin}:${process.env.PATH}`, NODE_TEST_CONTEXT: '' },
  })
  assert.match(out, /^qa 0: failed: the QA browser stopped/m)
})
