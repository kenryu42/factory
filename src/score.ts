import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BENCH_DIR, cellName, loadTask, type BenchTask } from './bench.ts'
import { harnesses } from './harnesses.ts'
import type { BenchResult, RunRecord, ScoreSubject, Step } from './types.ts'

// The deterministic scorer. Every other scorer is a judge file in scorers/.
export const CORRECTNESS = 'correctness'
const MAX_TOOL_OUTPUT = 2000
const CHECK_TAIL_LINES = 80
const CHECK_TIMEOUT_MS = 10 * 60 * 1000

// Where a score is stored in factory-runs.
export const scorePath = (subject: ScoreSubject, scorer: string) => subject.kind === 'run'
  ? `scores/${subject.runId}/${scorer}.json`
  : `scores/bench/${subject.benchId}/${subject.cell}/${scorer}.json`

// The run a score grades, or null for a bench cell's score.
export const scoredRun = (s: { subject: ScoreSubject }) => (s.subject.kind === 'run' ? s.subject.runId : null)

export const benchSubject = (c: BenchResult): Extract<ScoreSubject, { kind: 'bench' }> =>
  ({ kind: 'bench', benchId: c.benchId, cell: cellName(c.task, { harness: c.harness, model: c.requestedModel }) })

// Scorers grade implement runs that pushed a PR branch. Correctness also needs a bench task to check against.
export function pendingScores(records: RunRecord[], scorers: string[], existingFiles: string[]): { run: RunRecord; scorer: string }[] {
  const existing = new Set(existingFiles)
  return records
    .filter((r) => r.kind === 'implement' && r.branch !== null)
    .flatMap((run) => scorers
      .filter((scorer) => scorer !== CORRECTNESS || run.task !== null)
      .filter((scorer) => !existing.has(scorePath({ kind: 'run', runId: run.id }, scorer)))
      .map((scorer) => ({ run, scorer })))
}

// The judges also grade bench cells whose transcript and diff were stored. Correctness is the cell's own check.
export function pendingBenchScores(cells: BenchResult[], scorers: string[], existingFiles: string[]): { cell: BenchResult; scorer: string }[] {
  const existing = new Set(existingFiles)
  return cells
    .filter((c) => c.transcript === 'stored' && c.diff === 'stored')
    .flatMap((cell) => scorers
      .filter((scorer) => scorer !== CORRECTNESS && !existing.has(scorePath(benchSubject(cell), scorer)))
      .map((scorer) => ({ cell, scorer })))
}

export type JudgeEvidence = { 'issue.md': string; 'diff.patch': string; 'transcript.md': string }

export const judgeEvidence = (issue: { title: string; body: string }, diff: string, stages: { name: string; steps: Step[] | null }[]): JudgeEvidence => ({
  'issue.md': `# ${issue.title}\n\n${issue.body}\n`,
  'diff.patch': diff.endsWith('\n') ? diff : `${diff}\n`,
  'transcript.md': transcriptMarkdown(stages),
})

// A bench cell's evidence: the task's issue text, the cell's stored diff, and its one implement stage.
export function benchEvidence(runsRepoDir: string, tasksDir: string, cell: BenchResult): JudgeEvidence {
  const file = (ext: string) => join(runsRepoDir, 'bench', cell.benchId, `${benchSubject(cell).cell}.${ext}`)
  return judgeEvidence(
    loadTask(tasksDir, cell.task),
    readFileSync(file('patch'), 'utf8'),
    [{ name: 'implement-0', steps: harnesses[cell.harness].steps(readFileSync(file('jsonl'), 'utf8')) }],
  )
}

// A fence longer than any backtick run in the text, so tool output can never close it early.
export function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}\n${text}\n${fence}`
}

const clip = (text: string) =>
  text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n[${text.length - MAX_TOOL_OUTPUT} more characters cut]` : text

// The agent's session as markdown for a judge: one section per message, tool call, and tool result.
// steps is null when the stage's transcript was withheld.
export function transcriptMarkdown(stages: { name: string; steps: Step[] | null }[]): string {
  return stages.map(({ name, steps }) => {
    const head = `# Stage ${name}`
    if (!steps) return `${head}\n\nThe transcript of this stage was withheld.`
    const sections = steps.map((s, i) => {
      if (s.kind === 'message') return `## ${i + 1}. Message\n\n${s.text}`
      if (s.kind === 'tool_call') return `## ${i + 1}. Tool call: ${s.tool}\n\n${fenced(s.input)}`
      return `## ${i + 1}. Tool result${s.isError ? ' (error)' : ''}\n\n${fenced(clip(s.output) || '(no output)')}`
    })
    return [head, ...sections].join('\n\n')
  }).join('\n\n') + '\n'
}

export type Grade = { pass: boolean | null; reason: string }

// A bench cell's change and its grade. The diff is taken before the check is copied in, so it holds the agent's own
// files only. base is the untouched checkout at the task's base commit; its .git is read and never written. tree is modified.
export function diffAndGrade(base: string, tree: string, tasksDir: string, task: BenchTask, wrap: string[] = []): { diff: string; grade: Grade } {
  const gitDir = spawnSync('git', ['-C', base, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).stdout.trim()
  // A throwaway index, so the base checkout's own index is never touched.
  const index = join(mkdtempSync(join(tmpdir(), 'index-')), 'index')
  const git = (...args: string[]) => {
    const r = spawnSync('git', [`--git-dir=${gitDir}`, `--work-tree=${tree}`, '-C', tree, ...args],
      { encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: index }, maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`)
    return r.stdout
  }
  git('add', '-A')
  // A base that holds the repo's bench tasks lost them in its checkout, and that deletion is not the agent's change.
  const diff = git('diff', '--cached', '--no-color', task.base, '--', '.', `:(exclude)${BENCH_DIR}`)
  rmSync(dirname(index), { recursive: true, force: true })
  return { diff, grade: gradeTree(tree, tasksDir, task, wrap) }
}

// Copies the task's check files into the tree, replacing the repo's own file at the same path, and runs the task's
// grade command there, without the repo's bench tasks. It passes when the command exits 0. `wrap` is the command that
// runs it, such as `docker run ... <image>`; without it the command runs on the host. The tree is modified, so pass a copy.
export function gradeTree(tree: string, tasksDir: string, task: Pick<BenchTask, 'id' | 'check' | 'grade'>, wrap: string[] = []): Grade {
  rmSync(join(tree, BENCH_DIR), { recursive: true, force: true })
  for (const path of task.check) {
    const source = join(tasksDir, task.id, path)
    if (!existsSync(source)) return { pass: null, reason: `no check at ${source}` }
    mkdirSync(dirname(join(tree, path)), { recursive: true })
    copyFileSync(source, join(tree, path))
  }
  const log = join(mkdtempSync(join(tmpdir(), 'check-')), 'output.txt')
  const fd = openSync(log, 'w')
  // A test runner that is itself under `node --test` sets this, and it would change the child's reporting.
  const { NODE_TEST_CONTEXT, ...env } = process.env
  const command = [...wrap, 'sh', '-c', task.grade]
  const r = spawnSync(command[0], command.slice(1), { cwd: tree, env, stdio: ['ignore', fd, fd], timeout: CHECK_TIMEOUT_MS })
  closeSync(fd)
  const tail = readFileSync(log, 'utf8').trimEnd().split('\n').slice(-CHECK_TAIL_LINES).join('\n')
  if (r.error && !r.signal) return { pass: null, reason: `could not run the check: ${r.error.message}` }
  return { pass: r.status === 0, reason: tail || `exit ${r.status ?? r.signal}` }
}
