import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunRecord, Step } from './types.ts'

// The deterministic scorer. Every other scorer is a judge file in scorers/.
export const CORRECTNESS = 'correctness'
// The name the task's hidden check gets in the graded tree.
export const CHECK_FILE = 'test/zz-bench-check.test.js'
const MAX_TOOL_OUTPUT = 2000
const CHECK_TAIL_LINES = 80
const CHECK_TIMEOUT_MS = 10 * 60 * 1000

// Scorers grade implement runs that pushed a PR branch. Correctness also needs a bench task to check against.
export function pendingScores(records: RunRecord[], scorers: string[], existingFiles: string[]): { run: RunRecord; scorer: string }[] {
  const existing = new Set(existingFiles)
  return records
    .filter((r) => r.kind === 'implement' && r.branch !== null)
    .flatMap((run) => scorers
      .filter((scorer) => scorer !== CORRECTNESS || run.task !== null)
      .filter((scorer) => !existing.has(`scores/${run.id}/${scorer}.json`))
      .map((scorer) => ({ run, scorer })))
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

// Runs the tree's whole test suite with the task's check added as CHECK_FILE. It passes only
// when every test passes, so a change that breaks the repo's own tests fails too. `wrap` is the command that runs
// node, such as `docker run ... <image>`; without it node runs on the host. The tree is modified, so pass a copy.
export function gradeTree(tree: string, checkFile: string, wrap: string[] = []): Grade {
  if (!existsSync(checkFile)) return { pass: null, reason: `no check at ${checkFile}` }
  mkdirSync(join(tree, 'test'), { recursive: true })
  copyFileSync(checkFile, join(tree, CHECK_FILE))
  const log = join(mkdtempSync(join(tmpdir(), 'check-')), 'output.txt')
  const fd = openSync(log, 'w')
  // A test runner that is itself under `node --test` sets this, and it would change the child's reporting.
  const { NODE_TEST_CONTEXT, ...env } = process.env
  const command = [...wrap, 'node', '--test', '--test-reporter=spec', '--test-timeout=120000']
  const r = spawnSync(command[0], command.slice(1), { cwd: tree, env, stdio: ['ignore', fd, fd], timeout: CHECK_TIMEOUT_MS })
  closeSync(fd)
  const tail = readFileSync(log, 'utf8').trimEnd().split('\n').slice(-CHECK_TAIL_LINES).join('\n')
  if (r.error && !r.signal) return { pass: null, reason: `could not run the check: ${r.error.message}` }
  return { pass: r.status === 0, reason: tail || `exit ${r.status ?? r.signal}` }
}
