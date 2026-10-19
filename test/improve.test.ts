import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { findingsMarkdown, patchProblems, type Evidence } from '../src/improve.ts'
import { gradeTree } from '../src/score.ts'
import type { BenchResult, Improvement, RunRecord, Score, StageRun } from '../src/types.ts'

const temps: string[] = []
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })))

const checkPath = fileURLToPath(new URL('../bench/tasks/negative-money/check.test.js', import.meta.url))
// A real record: pi resolved factory-sandbox#14 (bench task negative-money), and the review approved.
const realRun = (over: Partial<RunRecord> = {}): RunRecord => ({ ...JSON.parse(readFileSync(new URL('./fixtures/run-negative-money.json', import.meta.url), 'utf8')), ...over })

const stage = (agent: StageRun['agent'], round: number, verdict: StageRun['verdict'] = null): StageRun => ({
  agent, round, harness: 'claude-code', model: 'claude-sonnet-5', billing: 'subscription', ok: true, verdict,
  usage: { inputTokens: 1000, cacheReadTokens: 5000, outputTokens: 300, costUsd: 0.25 }, startedAt: '2026-10-19T05:30:00Z', wallTimeS: 120, transcript: 'stored',
})

const score = (runId: string, scorer: string, pass: boolean | null, reason = 'reason'): Score => ({
  subject: { kind: 'run', runId }, scorer, pass, reason, sha: 'abc1234', factorySha: 'f', at: '2026-10-19T06:00:00Z', judge: null,
})

const cell = (over: Partial<BenchResult>): BenchResult => ({
  benchId: 'b1', task: 'negative-money', harness: 'pi', requestedModel: 'deepseek/deepseek-v4-flash', model: 'deepseek-v4-flash', factoryRef: 'main',
  factorySha: 'f'.repeat(40), baseSha: 'b'.repeat(40), billing: 'api', pass: true, checkOutput: 'ℹ pass 9', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1, costUsd: 0.02 },
  costUsd: 0.02, wallTimeS: 30, at: '2026-10-19T06:00:00Z', transcript: 'stored', diff: 'stored', ...over,
})

// The real output of the negative-money check on a tree that did not fix the bug and also broke one of its own tests.
function failingCheckOutput(): string {
  const tree = temp('tree-')
  mkdirSync(join(tree, 'src'))
  mkdirSync(join(tree, 'test'))
  writeFileSync(join(tree, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(tree, 'src', 'money.js'), 'export function formatMoney(n) { return "$" + n.toFixed(2) }\n')
  writeFileSync(join(tree, 'test', 'own.test.js'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('totals add up', () => assert.equal(1, 2))\n")
  const grade = gradeTree(tree, checkPath)
  assert.equal(grade.pass, false)
  return grade.reason
}

const evidence = (over: Partial<Evidence>): Evidence => ({ records: [], scores: [], bench: [], reviews: {}, ...over })

test('findings count each scorer per implement harness and list each failing score with its run, task, harness and reason', () => {
  const pi = realRun()
  const cc = realRun({ id: 'cc-1', harness: 'claude-code', model: 'claude-sonnet-5', task: null, verdict: 'request_changes' })
  const md = findingsMarkdown(evidence({
    records: [pi, cc],
    scores: [
      score(pi.id, 'correctness', true),
      score(pi.id, 'scope', true),
      score(cc.id, 'scope', false, 'The diff reformats src/report.ts, which the issue never mentions.'),
      score(cc.id, 'honest-summary', null, 'The judge did not finish.'),
    ],
  }))
  assert.match(md, /^2 runs, 4 scores \(1 failing\)/m)
  assert.match(md, /^\| correctness \| 0 \/ 0 \/ 0 \| 1 \/ 0 \/ 0 \|$/m)
  assert.match(md, /^\| scope \| 0 \/ 1 \/ 0 \| 1 \/ 0 \/ 0 \|$/m)
  assert.match(md, /^\| honest-summary \| 0 \/ 0 \/ 1 \| 0 \/ 0 \/ 0 \|$/m)
  const scope = md.slice(md.indexOf('## Failing scope scores (1)'))
  assert.match(scope, /- run `cc-1` · claude-code `claude-sonnet-5` · final review request_changes/)
  assert.match(scope, /The diff reformats src\/report\.ts/)
  assert.ok(!md.includes('## Failing honest-summary'), 'an unknown score is not a failure')
  assert.ok(!md.includes('## The review approved'), 'no correctness failure, so no missed defect')
})

test('a change the review approved but correctness failed is listed with the review text', () => {
  const missed = realRun()
  const caught = realRun({ id: 'ok-1' })
  const md = findingsMarkdown(evidence({
    records: [missed, caught],
    scores: [score(missed.id, 'correctness', false, failingCheckOutput()), score(caught.id, 'correctness', true)],
    reviews: { [missed.id]: 'The change resolves the issue. Tests pass.\n\nVERDICT: approve', [caught.id]: 'Looks right.\n\nVERDICT: approve' },
  }))
  assert.match(md, /approved and correct 1, approved and wrong 1/)
  const section = md.slice(md.indexOf('## The review approved a change that failed correctness (1)'), md.indexOf('## Failing correctness'))
  assert.match(section, /- run `39242721467-1` · task `negative-money` · pi `deepseek\/deepseek-v4-pro` · final review approve/)
  assert.match(section, /The change resolves the issue\. Tests pass\./)
  assert.ok(!section.includes('ok-1'))
})

test("the hidden check's tests and assertions never reach the findings, only what failed", () => {
  const output = failingCheckOutput()
  assert.match(output, /negative amounts put the sign before the dollar sign/, 'the raw output names the hidden test')
  const run = realRun()
  const md = findingsMarkdown(evidence({
    records: [run],
    scores: [score(run.id, 'correctness', false, output)],
    bench: [cell({ pass: false, checkOutput: output }), cell({ task: 'recurring' })],
    reviews: { [run.id]: 'VERDICT: approve' },
  }))
  const check = readFileSync(checkPath, 'utf8')
  for (const line of check.split('\n').map((l) => l.trim()).filter((l) => l.length > 12)) assert.ok(!md.includes(line), `leaked: ${line}`)
  assert.ok(!md.includes('negative amounts put the sign'))
  assert.ok(!md.includes("'-$12.00'"))
  assert.match(md, /Check: 1 test of the hidden check failed; the repo's own tests failed in `test\/own\.test\.js`\./)
  assert.match(md, /^\| pi:deepseek\/deepseek-v4-flash \| 2 \| 50% \| \$0\.02 \|$/m)
  assert.match(md, /## Failing cells of benchmark b1 \(1\)\n\n- task `negative-money` · pi:deepseek\/deepseek-v4-flash/)
})

test('review rounds: how often the first review asked for changes and how the revision then scored', () => {
  const revised = (id: string, final: 'approve' | 'request_changes') => realRun({
    id, verdict: final, stages: [stage('implement', 0), stage('review', 0, 'request_changes'), stage('implement', 1), stage('review', 1, final)],
  })
  const md = findingsMarkdown(evidence({
    records: [revised('a', 'approve'), revised('b', 'request_changes'), realRun({ id: 'c' }), realRun({ id: 'd', status: 'agent_failed', verdict: null, stages: [stage('implement', 0)] })],
    scores: [score('a', 'correctness', true), score('b', 'correctness', false), score('c', 'correctness', true)],
  }))
  assert.match(md, /The first review approved 1 of 3 reviewed runs: correctness 1 pass, 0 fail, 0 unscored\./)
  assert.match(md, /It requested changes on 2\. 2 were revised: correctness 1 pass, 1 fail, 0 unscored; the second review approved 1 of them\./)
  assert.match(md, /1 implement runs had no review\./)
})

test('a long group lists the first 15 and says how many were cut', () => {
  const runs = Array.from({ length: 20 }, (_, i) => realRun({ id: `run-${i}` }))
  const md = findingsMarkdown(evidence({ records: runs, scores: runs.map((r) => score(r.id, 'scope', false, `unrelated change ${r.id}`)) }))
  assert.match(md, /## Failing scope scores \(20\)/)
  assert.equal(md.match(/^- run `run-\d+`/gm)!.length, 15)
  assert.match(md, /\[5 more cut\]/)
})

test('findings over 60KB are cut from the end with a note, and the counts at the top survive', () => {
  const runs = Array.from({ length: 15 }, (_, i) => realRun({ id: `run-${i}` }))
  const scorers = Array.from({ length: 12 }, (_, i) => `judge-${i}`)
  const md = findingsMarkdown(evidence({ records: runs, scores: scorers.flatMap((j) => runs.map((r) => score(r.id, j, false, 'x'.repeat(900)))) }))
  assert.ok(md.length < 60_200)
  assert.match(md, /\[findings cut at 60000 characters; \d+ more were dropped\]\n$/)
  assert.match(md, /^\| judge-11 \| 0 \/ 0 \/ 0 \| 0 \/ 15 \/ 0 \|$/m)
})

const diffFor = (path: string, { mode = '100644', added = false } = {}) => [
  `diff --git a/${path} b/${path}`,
  ...(added ? [`new file mode ${mode}`, 'index 0000000..3b18e51'] : [`index 3b18e51..5d1f2a0 ${mode}`]),
  added ? '--- /dev/null' : `--- a/${path}`,
  `+++ b/${path}`,
  '@@ -1,3 +1,4 @@',
  ' ---',
  '+- Run the whole test suite before you approve.',
  '',
].join('\n')

test('the scope gate passes changes to the graded agents prompts', () => {
  assert.deepEqual(patchProblems(diffFor('agents/review.md') + diffFor('agents/triage.md', { added: true })), [])
})

test('the scope gate rejects its own prompt, judges, code, workflows, bench tasks, the image, and paths that climb out', () => {
  for (const path of ['src/cli.ts', 'bench/tasks/negative-money/check.test.js', '.github/workflows/run.yml', 'docker/Dockerfile',
    'agents/../src/x.md', 'agents/sub/x.md', 'agents/review.txt', 'README.md', 'agents/improve.md', 'scorers/scope.md']) {
    assert.deepEqual(patchProblems(diffFor('agents/review.md') + diffFor(path)), [`out of scope: ${path}`], path)
  }
  assert.deepEqual(patchProblems(diffFor('agents/link.md', { added: true, mode: '120000' })), ['not a regular file (mode 120000)'])
  assert.deepEqual(patchProblems('diff --git "a/agents/r\\303\\251view.md" "b/agents/r\\303\\251view.md"\n'), ['out of scope: "a/agents/r\\303\\251view.md" "b/agents/r\\303\\251view.md"'])
})

// propose runs against the git repo it is started in, so each test gets its own factory checkout, a bare origin, a
// runs directory, and a fake gh that records what it was asked to open.
function proposeSetup(patchPath = 'agents/review.md') {
  const root = temp('propose-')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_GH: join(root, 'gh') }
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Owner\n\temail = owner@example.com\n[init]\n\tdefaultBranch = main\n')
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'gh'), '#!/bin/sh\nmkdir -p "$FAKE_GH"\necho "$@" > "$FAKE_GH/args"\nwhile [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$FAKE_GH/body"; shift; done\necho https://github.com/kenryu42/factory/pull/99\n')
  chmodSync(join(root, 'bin', 'gh'), 0o755)
  const repo = join(root, 'factory')
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  spawnSync('git', ['init', '--quiet', '--bare', join(root, 'origin.git')], { env })
  mkdirSync(join(repo, 'agents'), { recursive: true })
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'agents', 'review.md'), '---\nharness: claude-code\n---\nReview the change.\n')
  writeFileSync(join(repo, 'src', 'cli.ts'), 'export {}\n')
  git('init', '--quiet')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'init')
  git('remote', 'add', 'origin', join(root, 'origin.git'))
  git('push', '--quiet', '-u', 'origin', 'main')
  const factorySha = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, patchPath), readFileSync(join(repo, patchPath), 'utf8') + 'Run the whole test suite before you approve.\n')
  const patch = git('diff') + '\n'
  git('checkout', '--quiet', '.')

  const id = '4242-1'
  const dir = join(root, 'runs', 'improvements', id)
  mkdirSync(dir, { recursive: true })
  const improvement: Improvement = {
    id, at: '2026-10-19T08:00:00Z', factorySha, basis: { runs: 12, scores: 30, failingScores: 7, benches: [] }, harness: 'claude-code',
    model: 'claude-sonnet-5', costUsd: 0.4, wallTimeS: 200, changedFiles: [patchPath], status: 'proposed',
  }
  writeFileSync(join(dir, 'improvement.json'), JSON.stringify(improvement))
  writeFileSync(join(dir, 'patch.diff'), patch)
  writeFileSync(join(dir, 'summary.md'), 'make the review run the full test suite\n\n**Pattern.** The review approved 4 runs that failed correctness.\n')
  const propose = () => spawnSync('node', [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'propose', join(root, 'runs'), id], { cwd: repo, env, encoding: 'utf8' })
  return { root, repo, git, id, propose, env }
}

test('propose pushes a branch with the patch, opens a PR with the summary, and returns to the branch it started on', () => {
  const { root, repo, git, id, propose, env } = proposeSetup()
  const r = propose()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), `propose: improve/${id}: https://github.com/kenryu42/factory/pull/99`)
  const origin = (...args: string[]) => spawnSync('git', ['--git-dir', join(root, 'origin.git'), ...args], { env, encoding: 'utf8' }).stdout.trim()
  assert.equal(origin('log', '-1', '--format=%s', `improve/${id}`), 'feat(agents): make the review run the full test suite')
  assert.match(origin('log', '-1', '--format=%b', `improve/${id}`), /\*\*Pattern\.\*\* The review approved 4 runs/)
  assert.match(origin('show', `improve/${id}:agents/review.md`), /Run the whole test suite before you approve\.$/)
  assert.ok(readFileSync(join(root, 'gh', 'args'), 'utf8').startsWith(`pr create --head improve/${id} --title feat(agents): make the review run the full test suite --body-file `))
  const body = readFileSync(join(root, 'gh', 'body'), 'utf8')
  assert.match(body, /^\*\*Pattern\.\*\* The review approved 4 runs that failed correctness\.\n\n---\n/)
  assert.match(body, /improvement `4242-1` in factory-runs/)
  assert.ok(!/https?:\/\//.test(body), 'the body links nowhere')
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(git('status', '--porcelain'), '')
  assert.ok(existsSync(join(repo, 'agents', 'review.md')))
})

test('propose refuses a dirty working tree and creates no branch', () => {
  const { root, repo, git, propose } = proposeSetup()
  writeFileSync(join(repo, 'notes.txt'), 'wip\n')
  const r = propose()
  assert.equal(r.status, 1)
  assert.equal(r.stderr.trim(), 'propose: refusing: the working tree has uncommitted changes; commit or stash them first')
  assert.equal(git('branch', '--list', 'improve/*'), '')
  assert.ok(!existsSync(join(root, 'gh')), 'gh was never called')
})

test('propose refuses a patch that touches code, and creates no branch', () => {
  const { root, git, propose } = proposeSetup('src/cli.ts')
  const r = propose()
  assert.equal(r.status, 1)
  assert.equal(r.stderr.trim(), 'propose: refusing: the patch changes more than the agent prompts in agents/: out of scope: src/cli.ts')
  assert.equal(git('branch', '--list', 'improve/*'), '')
  assert.ok(!existsSync(join(root, 'gh')))
})

test("a bench cell's failing judge score is listed with its benchmark, task and config, and the bench table shows judge rates", () => {
  const failing: Score = {
    ...score('', 'redundant-tests', false, 'test/money.test.js repeats the existing two-decimals test.'),
    subject: { kind: 'bench', benchId: 'b1', cell: 'negative-money__pi__deepseek_deepseek-v4-flash' },
  }
  const md = findingsMarkdown(evidence({ bench: [cell({})], scores: [failing] }))
  assert.match(md, /^\| Config \| Tasks \| Pass rate \| redundant-tests \| Avg cost \|$/m)
  assert.match(md, /^\| pi:deepseek\/deepseek-v4-flash \| 1 \| 100% \| 0% \| \$0\.02 \|$/m)
  const section = md.slice(md.indexOf('## Failing redundant-tests scores (1)'))
  assert.match(section, /- benchmark `b1` · task `negative-money` · pi:deepseek\/deepseek-v4-flash · \$0\.02\n  The judge's reason:/)
  assert.match(section, /repeats the existing two-decimals test/)
})
