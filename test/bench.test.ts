import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cellName, cloneBase, loadTasks, parseConfigs, parseTask, selectTasks } from '../src/bench.ts'

test('configs are harness:model pairs, and the model may hold a slash or a colon', () => {
  assert.deepEqual(parseConfigs('claude-code:haiku, pi:deepseek/deepseek-flash,'), [
    { harness: 'claude-code', model: 'haiku' },
    { harness: 'pi', model: 'deepseek/deepseek-flash' },
  ])
  assert.deepEqual(parseConfigs('pi:ollama/qwen3:32b'), [{ harness: 'pi', model: 'ollama/qwen3:32b' }])
})

test('an unknown harness, a missing model, or no configs at all is rejected', () => {
  assert.throws(() => parseConfigs('gemini:flash'), /harness must be one of claude-code, pi/)
  assert.throws(() => parseConfigs('claude-code:haiku,pi:'), /"pi:": no model/)
  assert.throws(() => parseConfigs('pi'), /no model/)
  assert.throws(() => parseConfigs(' , '), /no bench configs/)
})

// A checkout of a repo that holds one bench task.
const sandbox = fileURLToPath(new URL('./fixtures/sandbox', import.meta.url))
const BASE = 'f1a6e79b1444686e1f0cc6edc601834259d574db'
const taskFile = (front: string, issue = '# Refunds are wrong\n\nFix them.') => `---\n${front}\n---\n${issue}\n`
const valid = `base: ${BASE}\ncheck: tests/export.test.mjs, tests/fixtures/a.yaml\nsetup: bun install --frozen-lockfile\ngrade: node --test tests/export.test.mjs`

test("a repo's task files live in .factory/bench/tasks: frontmatter naming the base, check and grade, then the issue", () => {
  assert.deepEqual(loadTasks(sandbox), [{
    id: 'negative-money',
    base: BASE,
    check: ['test/zz-bench-check.test.js'],
    setup: null,
    grade: 'node --test --test-reporter=spec --test-timeout=120000',
    fix: null,
    title: 'Refunds print as $-12.00',
    body: '`formatMoney(-12)` returns `$-12.00`. It should be `-$12.00`. Positive amounts should not change.',
  }])
  assert.deepEqual(loadTasks(join(sandbox, 'src')), [], 'a repo without the directory has no tasks')
  const task = parseTask('export', taskFile(valid))
  assert.deepEqual(task.check, ['tests/export.test.mjs', 'tests/fixtures/a.yaml'])
  assert.equal(task.setup, 'bun install --frozen-lockfile')
})

test('a task file with a missing or malformed field is rejected with the file and field named', () => {
  assert.throws(() => parseTask('t', '# Refunds are wrong\n\nFix them.'), /\.factory\/bench\/tasks\/t\/task\.md: missing --- frontmatter/)
  assert.throws(() => parseTask('t', taskFile(valid.replace(/^base: .*$/m, ''))), /task\.md: missing base/)
  assert.throws(() => parseTask('t', taskFile(valid.replace(BASE, 'f1a6e79'))), /base must be a full 40-character commit sha, got "f1a6e79"/)
  assert.throws(() => parseTask('t', taskFile(valid.replace(/^grade: .*$/m, ''))), /missing grade/)
  assert.throws(() => parseTask('t', taskFile(`${valid}\nchecks: x`)), /unknown frontmatter checks/)
  assert.throws(() => parseTask('t', taskFile(`${valid}\nrepo: kenryu42/factory-sandbox`)), /unknown frontmatter repo/)
  assert.throws(() => parseTask('t', taskFile(valid.replace('tests/fixtures/a.yaml', '../../src/cli.ts'))), /check paths must stay inside the task directory: \.\.\/\.\.\/src\/cli\.ts/)
  assert.throws(() => parseTask('t', taskFile(`${valid}\nfix: HEAD`)), /fix must be a full 40-character commit sha/)
  assert.throws(() => parseTask('t', taskFile(valid, 'Refunds are wrong.')), /"# Title" line/)
})

test("a repo's bench runs all of its tasks, or the ones named", () => {
  const tasks = ['export', 'import', 'negative-money'].map((id) => parseTask(id, taskFile(valid)))
  assert.deepEqual(selectTasks(tasks, 'all').map((t) => t.id), ['export', 'import', 'negative-money'])
  assert.deepEqual(selectTasks(tasks, ' import, export ').map((t) => t.id), ['import', 'export'])
  assert.throws(() => selectTasks(tasks, 'export,nope'), /unknown bench task nope; the repo has export, import, negative-money/)
  assert.throws(() => selectTasks([], 'all'), /no bench tasks in \.factory\/bench\/tasks/)
  assert.throws(() => selectTasks(tasks, ' , '), /no bench tasks given/)
})

const temps: string[] = []
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })))

test("the agent's tree is the base commit alone, without the repo's bench tasks even when the base holds them", () => {
  const repo = mkdtempSync(join(tmpdir(), 'bench-repo-'))
  const dest = mkdtempSync(join(tmpdir(), 'bench-base-'))
  temps.push(repo, dest)
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  git('init', '--quiet')
  mkdirSync(join(repo, '.factory', 'bench', 'tasks', 'refunds', 'test'), { recursive: true })
  writeFileSync(join(repo, '.factory', 'qa.json'), '{}\n')
  writeFileSync(join(repo, '.factory', 'bench', 'tasks', 'refunds', 'test', 'zz-bench-check.test.js'), 'hidden check\n')
  writeFileSync(join(repo, 'money.js'), 'unfixed\n')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, 'money.js'), 'fixed\n')
  git('commit', '--quiet', '-am', 'fix')

  cloneBase(repo, { id: 'refunds', base }, dest)
  assert.ok(!existsSync(join(dest, '.factory', 'bench')), 'no bench tasks in the agent tree')
  assert.deepEqual(readdirSync(join(dest, '.factory')), ['qa.json'], 'the rest of .factory stays')
  assert.equal(readFileSync(join(dest, 'money.js'), 'utf8'), 'unfixed\n')
  assert.equal(spawnSync('git', ['-C', dest, 'rev-list', '--all', '--count'], { encoding: 'utf8' }).stdout.trim(), '1', 'the fix is not in its history')
  assert.throws(() => cloneBase(repo, { id: 'refunds', base: 'a'.repeat(40) }, dest), /refunds: base a{40} is not in .*full history/)
})

test('each cell has its own result file, with the model made path-safe', () => {
  assert.equal(cellName('negative-money', { harness: 'pi', model: 'deepseek/deepseek-flash' }), 'negative-money__pi__deepseek_deepseek-flash')
  assert.notEqual(cellName('recurring', { harness: 'claude-code', model: 'haiku' }), cellName('recurring', { harness: 'claude-code', model: 'sonnet' }))
})
