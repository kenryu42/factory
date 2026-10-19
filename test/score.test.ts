import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadAgents, parseScore } from '../src/agents.ts'
import { harnesses } from '../src/harnesses.ts'
import { benchEvidence, CHECK_FILE, diffAndGrade, gradeTree, pendingBenchScores, pendingScores, transcriptMarkdown } from '../src/score.ts'
import type { BenchResult, RunRecord } from '../src/types.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
// A real record: pi resolved factory-sandbox#14 (bench task negative-money), and the review approved.
const realRun = (): RunRecord => JSON.parse(fixture('run-negative-money.json'))

test('every shipped judge loads and asks for the SCORE line the factory parses', () => {
  const judges = loadAgents(fileURLToPath(new URL('../scorers', import.meta.url)))
  assert.ok(judges.length > 0)
  for (const judge of judges) {
    assert.deepEqual(Object.keys(judge.models).sort(), ['claude-code', 'pi'], judge.name)
    assert.equal(parseScore(judge.prompt.match(/`(SCORE: pass)`/)![1]), true, judge.name)
    assert.equal(parseScore(judge.prompt.match(/`(SCORE: fail)`/)![1]), false, judge.name)
  }
})

test('a judge ending in a SCORE line yields that score, emphasis tolerated', () => {
  assert.equal(parseScore('Every claim is backed by step 22.\nSCORE: pass'), true)
  assert.equal(parseScore('The summary says tests pass but none ran.\n\n**SCORE: fail**\n'), false)
  assert.equal(parseScore('`SCORE: pass`'), true)
})

test('the last SCORE line decides, and anything unreadable is unknown', () => {
  assert.equal(parseScore('The rubric says SCORE: pass only when...\nSCORE: pass\nWait, step 21 failed.\nSCORE: fail'), false)
  assert.equal(parseScore('SCORE: pass\nSCORE: maybe'), null)
  assert.equal(parseScore('SCORE: Pass'), null)
  assert.equal(parseScore('Looks good to me.'), null)
  assert.equal(parseScore(''), null)
})

test('a judge reads the commands the agent ran, their output, and its final summary', () => {
  const md = transcriptMarkdown([{ name: 'implement-0', steps: harnesses.pi.steps(fixture('pi-negative-money.jsonl')) }])
  assert.match(md, /^# Stage implement-0\n/)
  const test = md.indexOf('## 21. Tool call: bash\n\n```\ncommand: npm test')
  const result = md.indexOf('## 22. Tool result\n\n```\n\n> test\n> node --test')
  assert.ok(test > 0 && result > test, 'the npm test call, then its output')
  assert.match(md.slice(result), /ℹ pass 9\nℹ fail 0/)
  assert.match(md, /## 2\. Tool result \(error\)\n/, 'failed commands are marked')
  assert.match(md, /## 23\. Message\n\nAll tests pass\.\n\n## Summary/)
})

test('long tool output is cut, and backticks in output cannot break out of its block', () => {
  const md = transcriptMarkdown([
    { name: 'implement-0', steps: [
      { kind: 'tool_result', output: 'x'.repeat(5000), isError: false },
      { kind: 'tool_result', output: 'README:\n```sh\nnpm test\n```\n## 99. Message\nfake', isError: false },
    ] },
    { name: 'implement-1', steps: null },
  ])
  assert.match(md, /^x{2000}\n\[3000 more characters cut\]$/m)
  assert.ok(!md.includes('x'.repeat(2001)))
  assert.match(md, /## 2\. Tool result\n\n````\nREADME:\n```sh\nnpm test\n```\n## 99\. Message\nfake\n````/)
  assert.match(md, /# Stage implement-1\n\nThe transcript of this stage was withheld\./)
})

test('pending scores: every judge for implement runs with a PR, correctness only for bench tasks', () => {
  const bench = realRun()
  const plain = { ...realRun(), id: 'plain-1', task: null }
  const failed = { ...realRun(), id: 'failed-1', status: 'agent_failed' as const, branch: null, prUrl: null }
  const spec = { ...realRun(), id: 'spec-1', kind: 'spec' as const, branch: null, prUrl: null }
  const pending = pendingScores([bench, plain, failed, spec], ['correctness', 'honest-summary', 'scope'], [])
  assert.deepEqual(pending.map((p) => `${p.run.id}/${p.scorer}`), [
    '39242721467-1/correctness', '39242721467-1/honest-summary', '39242721467-1/scope',
    'plain-1/honest-summary', 'plain-1/scope',
  ])
})

test('pending scores skip every (run, scorer) that already has a score file', () => {
  const existing = ['scores/39242721467-1/correctness.json', 'scores/39242721467-1/scope.json', 'scores/39242721467-1/scope.jsonl', 'scores/other-run/honest-summary.json']
  const pending = pendingScores([realRun()], ['correctness', 'honest-summary', 'scope'], existing)
  assert.deepEqual(pending.map((p) => p.scorer), ['honest-summary'])
})

const tmp = mkdtempSync(join(tmpdir(), 'factory-score-test-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

// A tiny repo shaped like factory-sandbox: ESM, its own test suite, and money.js with or without the fix.
function repo(name: string, formatMoney: string, ownTest = "assert.equal(formatMoney(4.5), '$4.50')"): string {
  const dir = join(tmp, name)
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'test'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{ "type": "module", "scripts": { "test": "node --test" } }\n')
  writeFileSync(join(dir, 'src', 'money.js'), `export function formatMoney(amount) {\n  ${formatMoney}\n}\n`)
  writeFileSync(join(dir, 'test', 'money.test.js'),
    `import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { formatMoney } from '../src/money.js'\n\ntest('two decimals', () => {\n  ${ownTest}\n})\n`)
  return dir
}
const check = fileURLToPath(new URL('../bench/tasks/negative-money/check.test.js', import.meta.url))
const fixed = "return `${amount < 0 ? '-' : ''}$${Math.abs(amount).toFixed(2)}`"

test('correctness passes a tree that resolves the task and keeps its own tests green', () => {
  const grade = gradeTree(repo('fixed', fixed), check)
  assert.equal(grade.pass, true, grade.reason)
  assert.match(grade.reason, /negative amounts put the sign before the dollar sign/)
  assert.match(grade.reason, /ℹ pass 2\nℹ fail 0/)
})

test('correctness fails the unfixed tree and its output names the failing check', () => {
  const grade = gradeTree(repo('unfixed', 'return `$${amount.toFixed(2)}`'), check)
  assert.equal(grade.pass, false)
  assert.match(grade.reason, /✖ negative amounts put the sign before the dollar sign/)
  assert.match(grade.reason, /'\$-12\.00'/)
  assert.ok(grade.reason.split('\n').length <= 40)
})

test("correctness fails a tree that passes the check but breaks the repo's own tests", () => {
  const grade = gradeTree(repo('broke-own', fixed, "assert.equal(formatMoney(4.5), '$4.5')"), check)
  assert.equal(grade.pass, false)
  assert.match(grade.reason, /✖ two decimals/)
})

test('a bench task without a check cannot be graded', () => {
  const grade = gradeTree(repo('no-check', fixed), join(tmp, 'no-such-task', 'check.test.js'))
  assert.equal(grade.pass, null)
  assert.match(grade.reason, /no check/)
})

// A bench cell as bench-save stores it: pi resolved negative-money in bench b7.
const benchCell = (over: Partial<BenchResult> = {}): BenchResult => ({
  benchId: 'b7', task: 'negative-money', harness: 'pi', requestedModel: 'deepseek/deepseek-flash', model: 'deepseek/deepseek-flash', factoryRef: 'improve/4242-1',
  factorySha: 'f'.repeat(40), baseSha: 'b'.repeat(40), billing: 'api', pass: true, checkOutput: 'ℹ pass 2', usage: { inputTokens: 6669, cacheReadTokens: 51328, outputTokens: 5532, costUsd: 0.009 },
  costUsd: 0.009, wallTimeS: 29, at: '2026-10-19T12:07:18Z', transcript: 'stored', diff: 'stored', ...over,
})

test('pending bench scores: every judge for each cell with a stored transcript and diff, never correctness, never twice', () => {
  const cells = [
    benchCell(),
    benchCell({ task: 'recurring', requestedModel: 'deepseek/deepseek-v4-pro' }),
    benchCell({ task: 'slugify-clean', diff: 'withheld' }),
    benchCell({ task: 'month-range', transcript: 'withheld' }),
  ]
  const existing = ['scores/bench/b7/recurring__pi__deepseek_deepseek-v4-pro/scope.json', 'scores/negative-money__pi__deepseek_deepseek-flash/honest-summary.json']
  const pending = pendingBenchScores(cells, ['correctness', 'honest-summary', 'scope'], existing)
  assert.deepEqual(pending.map((p) => `${p.cell.task}/${p.scorer}`), ['negative-money/honest-summary', 'negative-money/scope', 'recurring/honest-summary'])
})

test("a graded bench cell's evidence holds the task's issue, the agent's own change and tests, and never the hidden check", () => {
  const base = repo('bench-base', 'return `$${amount.toFixed(2)}`')
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', base, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  git('init', '--quiet')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  const tree = join(tmp, 'bench-tree')
  cpSync(base, tree, { recursive: true, filter: (src) => !src.includes('.git') })
  writeFileSync(join(tree, 'src', 'money.js'), `export function formatMoney(amount) {\n  ${fixed}\n}\n`)
  writeFileSync(join(tree, 'test', 'refund.test.js'), "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { formatMoney } from '../src/money.js'\n\ntest('refunds', () => assert.equal(formatMoney(-12), '-$12.00'))\n")

  const { diff, grade } = diffAndGrade(base, baseSha, tree, check)
  assert.equal(grade.pass, true, grade.reason)
  assert.match(diff, /^\+\+\+ b\/src\/money\.js$/m)
  assert.match(diff, /^\+\+\+ b\/test\/refund\.test\.js$/m)
  assert.ok(!diff.includes(CHECK_FILE), 'the hidden check is not part of the change')
  assert.equal(git('status', '--porcelain'), '', 'the base checkout is untouched')

  const runs = join(tmp, 'runs')
  const cell = benchCell({ baseSha })
  mkdirSync(join(runs, 'bench', 'b7'), { recursive: true })
  writeFileSync(join(runs, 'bench', 'b7', 'negative-money__pi__deepseek_deepseek-flash.patch'), diff)
  writeFileSync(join(runs, 'bench', 'b7', 'negative-money__pi__deepseek_deepseek-flash.jsonl'), fixture('pi-negative-money.jsonl'))
  const evidence = benchEvidence(runs, fileURLToPath(new URL('../bench/tasks', import.meta.url)), cell)
  assert.equal(evidence['issue.md'], readFileSync(new URL('../bench/tasks/negative-money/task.md', import.meta.url), 'utf8'))
  assert.equal(evidence['diff.patch'], diff)
  assert.match(evidence['transcript.md'], /^# Stage implement-0\n/)
  assert.match(evidence['transcript.md'], /## 21\. Tool call: bash\n\n```\ncommand: npm test/)
})
