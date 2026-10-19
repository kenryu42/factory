import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { parseFrontmatter } from './agents.ts'
import { HARNESS_NAMES, isHarnessName, type BenchConfig } from './types.ts'

// `harness:model` pairs separated by commas, such as `claude-code:haiku,pi:deepseek/deepseek-flash`.
export function parseConfigs(text: string): BenchConfig[] {
  const configs = text.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const colon = entry.indexOf(':')
    const harness = colon < 0 ? entry : entry.slice(0, colon).trim()
    const model = colon < 0 ? '' : entry.slice(colon + 1).trim()
    if (!isHarnessName(harness)) throw new Error(`bench config "${entry}": harness must be one of ${HARNESS_NAMES.join(', ')}`)
    if (!model) throw new Error(`bench config "${entry}": no model; write it as ${harness}:<model>`)
    return { harness, model }
  })
  if (configs.length === 0) throw new Error('no bench configs given')
  return configs
}

// A repo's bench tasks live in the repo itself, one directory per task under BENCH_DIR/tasks on its default branch.
// No agent ever sees this directory: it is removed from every tree an agent works in or is graded in.
export const BENCH_DIR = '.factory/bench'
export const tasksDirOf = (checkout: string) => join(checkout, BENCH_DIR, 'tasks')

// A bench task: an issue on one commit of the repo that holds it, and the hidden check that grades the agent's tree.
export type BenchTask = {
  id: string
  // The commit the agent starts from.
  base: string
  // Paths inside the task's directory, copied to the same path in the graded tree after the agent finishes.
  // A file the repo already has at that path is replaced.
  check: string[]
  // Runs in the tree before the agent, with network, such as installing dependencies. null when there is nothing to set up.
  setup: string | null
  // Runs in the tree with the check copied in and no network. Exit 0 passes.
  grade: string
  // The commit that resolved the task in the repo's history, which bench-verify grades. null for a task written by hand.
  fix: string | null
  // The issue the agent gets.
  title: string
  body: string
}

const TASK_FIELDS = ['base', 'check', 'setup', 'grade', 'fix']

// task.md is frontmatter (base, check, optional setup, grade, optional fix), then the issue: a `# Title` line and the body.
export function parseTask(id: string, text: string): BenchTask {
  const file = `${BENCH_DIR}/tasks/${id}/task.md`
  const { fields, body: issue } = parseFrontmatter(file, text)
  const unknown = [...fields.keys()].filter((k) => !TASK_FIELDS.includes(k))
  if (unknown.length) throw new Error(`${file}: unknown frontmatter ${unknown.join(', ')}; expected ${TASK_FIELDS.join(', ')}`)
  const need = (key: string) => {
    const value = fields.get(key)
    if (!value) throw new Error(`${file}: missing ${key}`)
    return value
  }
  const sha = (key: string, value: string) => {
    if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${file}: ${key} must be a full 40-character commit sha, got "${value}"`)
    return value
  }
  const base = sha('base', need('base'))
  const fix = fields.has('fix') ? sha('fix', fields.get('fix')!) : null
  const check = need('check').split(',').map((p) => p.trim()).filter(Boolean)
  const outside = check.filter((p) => isAbsolute(p) || normalize(p).startsWith('..'))
  if (outside.length) throw new Error(`${file}: check paths must stay inside the task directory: ${outside.join(', ')}`)
  const [first, ...rest] = issue.trimStart().split('\n')
  const title = first.replace(/^#\s*/, '').trim()
  if (!first.startsWith('#') || !title) throw new Error(`${file}: the issue must start with a "# Title" line`)
  return { id, base, check, setup: fields.get('setup') || null, grade: need('grade'), fix, title, body: rest.join('\n').trim() }
}

export const loadTask = (tasksDir: string, id: string) => parseTask(id, readFileSync(join(tasksDir, id, 'task.md'), 'utf8'))

// Every task in a checkout of the repo.
export const loadTasks = (checkout: string) => {
  const dir = tasksDirOf(checkout)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => loadTask(dir, d.name)).sort((a, b) => a.id.localeCompare(b.id))
}

// `all` of a repo's tasks, or the ids given.
export function selectTasks(tasks: BenchTask[], wanted: string): BenchTask[] {
  if (wanted.trim() === 'all') {
    if (!tasks.length) throw new Error(`no bench tasks in ${BENCH_DIR}/tasks`)
    return tasks
  }
  const ids = wanted.split(',').map((t) => t.trim()).filter(Boolean)
  if (!ids.length) throw new Error('no bench tasks given')
  return ids.map((id) => {
    const task = tasks.find((t) => t.id === id)
    if (!task) throw new Error(`unknown bench task ${id}; the repo has ${tasks.map((t) => t.id).join(', ') || 'none'}`)
    return task
  })
}

// The task's base commit as a one-commit clone of `source`, a clone of the repo with the commit in its history. One
// commit, so the agent cannot read the later history that holds the fix it is asked to write, and without BENCH_DIR,
// so a base that already holds the tasks cannot show the agent their checks.
export function cloneBase(source: string, task: Pick<BenchTask, 'id' | 'base'>, dest: string) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', dest, ...args], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`)
  }
  git('init', '--quiet')
  try {
    git('fetch', '--quiet', '--depth=1', `file://${resolve(source)}`, task.base)
  } catch {
    throw new Error(`${task.id}: base ${task.base} is not in ${source}; check the repo out with its full history`)
  }
  git('checkout', '--quiet', '--detach', 'FETCH_HEAD')
  rmSync(join(dest, BENCH_DIR), { recursive: true, force: true })
}

// The file name of one cell's result, without extension.
export const cellName = (task: string, c: BenchConfig) => `${task}__${c.harness}__${c.model.replaceAll('/', '_')}`
