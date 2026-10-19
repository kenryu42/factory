// Each subcommand is one step of .github/workflows/run.yml. Steps share files in FACTORY_RUN_DIR.
//   guard   decide whether the issue event starts a run          (no secrets)
//   agent   run the harness in a container on the target repo    (model keys only)
//   publish copy the agent's tree into a fresh clone, open a PR  (FACTORY_GH_TOKEN)
//   record  push the run record and scrubbed transcript          (FACTORY_GH_TOKEN, keys for scrubbing)
//   db      build runs.sqlite from a local factory-runs checkout
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadAgent } from './agents.ts'
import { decide } from './guard.ts'
import { harnesses } from './harnesses.ts'
import { scrub } from './scrub.ts'
import type { AgentResult, Plan, PublishResult, RunRecord } from './types.ts'

const SECRET_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'DEEPSEEK_API_KEY', 'FACTORY_GH_TOKEN']
const AGENT_TIMEOUT_MS = 50 * 60 * 1000

const factoryDir = resolve(dirname(new URL(import.meta.url).pathname), '..')
const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}
const runDir = () => env('FACTORY_RUN_DIR')
const runFile = (name: string) => join(runDir(), name)
const readJson = <T>(name: string): T | null => (existsSync(runFile(name)) ? JSON.parse(readFileSync(runFile(name), 'utf8')) : null)
const writeJson = (name: string, value: unknown) => writeFileSync(runFile(name), JSON.stringify(value, null, 2) + '\n')

function sh(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (${r.status ?? r.signal}): ${String(r.stderr ?? '').trim()}`)
  return String(r.stdout ?? '').trim()
}

// Returns true when gitleaks finds a secret. Any gitleaks error also counts as a finding.
function hasLeak(text: string): boolean {
  const r = spawnSync('gitleaks', ['stdin', '--no-banner', '--redact', '--exit-code', '1', '--log-level', 'warn'], {
    input: text,
    encoding: 'utf8',
    cwd: mkdtempSync(join(tmpdir(), 'gitleaks-')),
  })
  if (r.status !== 0) console.log(`gitleaks: ${r.status === 1 ? 'possible secret found' : `error ${r.status ?? r.error}`}`)
  return r.status !== 0
}

function setOutput(key: string, value: string) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}

function guard() {
  const decision = decide(JSON.parse(readFileSync(env('GITHUB_EVENT_PATH'), 'utf8')))
  if (!decision.run) {
    console.log(`skip: ${decision.reason}`)
    setOutput('run', 'false')
    return
  }
  mkdirSync(runDir(), { recursive: true })
  writeJson('plan.json', { ...decision.plan, runId: runId() })
  console.log(`run: ${decision.plan.issue.repo}#${decision.plan.issue.number} harness=${decision.plan.harness ?? 'default'}`)
  setOutput('run', 'true')
}

function agent() {
  const plan = readJson<Plan>('plan.json')!
  const work = env('FACTORY_WORK_DIR')
  const def = loadAgent(factoryDir, 'implement')
  const harnessName = plan.harness ?? def.defaultHarness
  const harness = harnesses[harnessName]
  const model = def.models[harnessName]
  const keys = harness.keyEnv.filter((k) => process.env[k])
  if (keys.length === 0) throw new Error(`no API key for ${harnessName}: set ${harness.keyEnv.join(' or ')}`)

  const prompt = `${def.prompt}\n\n## Issue #${plan.issue.number}: ${plan.issue.title}\n\n${plan.issue.body}`
  const baseSha = sh('git', ['-C', work, 'rev-parse', 'HEAD'])
  const startedAt = new Date().toISOString()
  const out = openSync(runFile('transcript.jsonl'), 'w')
  const err = openSync(runFile('stderr.txt'), 'w')
  console.log(`agent: ${def.name} on ${harnessName} (${model})`)
  const r = spawnSync('docker', [
    'run', '--rm',
    '--user', `${process.getuid!()}:${process.getgid!()}`,
    '-e', 'HOME=/tmp/home',
    ...keys.flatMap((k) => ['-e', k]),
    '-v', `${resolve(work)}:/work`, '-w', '/work',
    process.env.FACTORY_IMAGE ?? 'factory-agent',
    ...harness.command(model, prompt),
  ], { stdio: ['ignore', out, err], timeout: AGENT_TIMEOUT_MS })
  closeSync(out)
  closeSync(err)

  const transcript = harness.parse(readFileSync(runFile('transcript.jsonl'), 'utf8'))
  const result: AgentResult = {
    ...transcript,
    ok: transcript.ok && r.status === 0,
    agent: def.name,
    harness: harnessName,
    model,
    baseSha,
    startedAt,
    wallTimeS: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
  }
  writeJson('result.json', result)
  console.log(`agent: exit=${r.status ?? r.signal} ok=${result.ok} cost=${result.usage.costUsd ?? 'n/a'} time=${result.wallTimeS}s`)
  if (!result.ok) console.log(scrub(readFileSync(runFile('stderr.txt'), 'utf8'), secrets()).split('\n').slice(-20).join('\n'))
}

function publish() {
  const plan = readJson<Plan>('plan.json')!
  const result = readJson<AgentResult>('result.json')
  const token = env('FACTORY_GH_TOKEN')
  const { repo, number } = plan.issue
  const ghEnv = { ...process.env, GH_TOKEN: token }
  const done = (p: PublishResult, comment: string) => {
    writeJson('publish.json', p)
    sh('gh', ['issue', 'comment', String(number), '--repo', repo, '--body', scrub(comment, secrets())], { env: ghEnv })
    console.log(`publish: ${p.status}${p.prUrl ? ` ${p.prUrl}` : ''}`)
  }
  const runUrl = runLink()

  if (!result?.ok) {
    const what = result ? `The ${result.harness} agent did not finish successfully` : 'The agent step crashed before the agent finished'
    return done({ status: 'agent_failed', branch: null, prUrl: null }, `${what}, so no pull request was opened. [Run log](${runUrl})`)
  }

  // A fresh clone the agent never touched, so nothing it planted in .git (hooks, config) runs here.
  const pub = runFile('pub')
  rmSync(pub, { recursive: true, force: true })
  sh('git', ['clone', '--quiet', `https://x-access-token:${token}@github.com/${repo}.git`, pub])
  const branch = `factory/issue-${number}-${plan.runId}`
  sh('git', ['-C', pub, 'checkout', '--quiet', '-b', branch, result.baseSha])
  sh('rsync', ['-a', '--delete', '--exclude=.git', `${resolve(env('FACTORY_WORK_DIR'))}/`, `${pub}/`])
  sh('git', ['-C', pub, 'add', '-A'])

  const changed = sh('git', ['-C', pub, 'diff', '--cached', '--name-only']).split('\n').filter(Boolean)
  if (changed.length === 0) {
    return done({ status: 'no_changes', branch: null, prUrl: null }, `The agent finished without changing any files.\n\n> ${result.finalText.slice(0, 1500)}\n\n[Run log](${runUrl})`)
  }
  if (changed.some((f) => f.startsWith('.github/'))) {
    return done({ status: 'blocked_workflow_change', branch: null, prUrl: null }, `Blocked: the agent changed files under \`.github/\`, which the factory never pushes. [Run log](${runUrl})`)
  }
  const cost = result.usage.costUsd === null ? 'n/a' : `$${result.usage.costUsd.toFixed(2)}`
  const body = scrub(`${result.finalText}\n\nCloses #${number}.\n\n---\nfactory run: \`${result.agent}\` on ${result.harness} (\`${result.model}\`), ${cost}, ${result.wallTimeS}s. [Run log](${runUrl})`, secrets())
  if (hasLeak(sh('git', ['-C', pub, 'diff', '--cached'], { maxBuffer: 64 * 1024 * 1024 }) + '\n' + body)) {
    return done({ status: 'blocked_secret', branch: null, prUrl: null }, `Blocked: gitleaks flagged a possible secret in the agent's changes or summary, so nothing was pushed. [Run log](${runUrl})`)
  }

  sh('git', ['-C', pub, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=factory', '-c', 'user.email=factory@users.noreply.github.com',
    'commit', '--quiet', '-m', `${plan.issue.title}\n\nResolves #${number}.`])
  sh('git', ['-C', pub, '-c', 'core.hooksPath=/dev/null', 'push', '--quiet', '--force', 'origin', branch])

  writeFileSync(runFile('pr-body.md'), body)
  const prUrl = sh('gh', ['pr', 'create', '--repo', repo, '--base', plan.baseBranch, '--head', branch, '--title', plan.issue.title, '--body-file', runFile('pr-body.md')], { env: ghEnv })
  done({ status: 'pr_opened', branch, prUrl }, `Opened ${prUrl}`)
}

function record() {
  const plan = readJson<Plan>('plan.json')!
  const result = readJson<AgentResult>('result.json')
  const published = readJson<PublishResult>('publish.json')
  const token = env('FACTORY_GH_TOKEN')
  const id = plan.runId

  const raw = existsSync(runFile('transcript.jsonl')) ? readFileSync(runFile('transcript.jsonl'), 'utf8') : ''
  const transcript = scrub(raw, secrets())
  const stored = transcript.length > 0 && !hasLeak(transcript)

  const def = loadAgent(factoryDir, 'implement')
  const harness = result?.harness ?? plan.harness ?? def.defaultHarness
  const rec: RunRecord = {
    id,
    startedAt: result?.startedAt ?? new Date().toISOString(),
    trigger: `issue#${plan.issue.number}`,
    factorySha: sh('git', ['-C', factoryDir, 'rev-parse', 'HEAD']),
    agent: def.name,
    harness,
    model: result?.model ?? def.models[harness],
    repo: plan.issue.repo,
    baseSha: result?.baseSha ?? '',
    branch: published?.branch ?? null,
    prUrl: published?.prUrl ?? null,
    status: published?.status ?? (result?.ok ? 'publish_failed' : 'agent_failed'),
    inputTokens: result?.usage.inputTokens ?? 0,
    cacheReadTokens: result?.usage.cacheReadTokens ?? 0,
    outputTokens: result?.usage.outputTokens ?? 0,
    costUsd: result?.usage.costUsd ?? null,
    wallTimeS: result?.wallTimeS ?? 0,
    transcript: stored ? 'stored' : 'withheld',
    runUrl: runLink(),
  }

  const runsRepo = `${plan.issue.repo.split('/')[0]}/factory-runs`
  const dir = runFile('runs-repo')
  rmSync(dir, { recursive: true, force: true })
  sh('git', ['clone', '--quiet', '--depth', '1', `https://x-access-token:${token}@github.com/${runsRepo}.git`, dir])
  mkdirSync(join(dir, 'runs'), { recursive: true })
  mkdirSync(join(dir, 'transcripts'), { recursive: true })
  writeFileSync(join(dir, 'runs', `${id}.json`), JSON.stringify(rec, null, 2) + '\n')
  if (stored) writeFileSync(join(dir, 'transcripts', `${id}.jsonl`), transcript)

  const git = (...args: string[]) => sh('git', ['-C', dir, '-c', 'user.name=factory', '-c', 'user.email=factory@users.noreply.github.com', ...args])
  git('add', '-A')
  if (git('status', '--porcelain') === '') return console.log(`record: ${id} already recorded`)
  git('commit', '--quiet', '-m', `run ${id}: ${rec.status} ${rec.repo}#${plan.issue.number}`)
  // Each run writes only its own files, so a rebase onto another run's push never conflicts.
  for (let attempt = 1; ; attempt++) {
    const push = spawnSync('git', ['-C', dir, 'push', '--quiet', 'origin', 'HEAD'], { encoding: 'utf8' })
    if (push.status === 0) break
    if (attempt === 5) throw new Error(`record: push failed 5 times: ${push.stderr}`)
    git('pull', '--quiet', '--rebase', 'origin', sh('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']))
  }
  console.log(`record: ${id} ${rec.status} transcript=${rec.transcript} cost=${rec.costUsd ?? 'n/a'}`)
}

function db(runsRepoDir: string) {
  const file = join(runsRepoDir, 'runs.sqlite')
  rmSync(file, { force: true })
  const database = new DatabaseSync(file)
  database.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY, started_at TEXT, trigger TEXT, factory_sha TEXT, agent TEXT, harness TEXT, model TEXT,
    repo TEXT, base_sha TEXT, branch TEXT, pr_url TEXT, status TEXT, input_tokens INTEGER, cache_read_tokens INTEGER,
    output_tokens INTEGER, cost_usd REAL, wall_time_s INTEGER, transcript TEXT, run_url TEXT)`)
  const insert = database.prepare(`INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const files = readdirSync(join(runsRepoDir, 'runs')).filter((f) => f.endsWith('.json'))
  for (const f of files) {
    const r: RunRecord = JSON.parse(readFileSync(join(runsRepoDir, 'runs', f), 'utf8'))
    insert.run(r.id, r.startedAt, r.trigger, r.factorySha, r.agent, r.harness, r.model, r.repo, r.baseSha, r.branch,
      r.prUrl, r.status, r.inputTokens, r.cacheReadTokens, r.outputTokens, r.costUsd, r.wallTimeS, r.transcript, r.runUrl)
  }
  database.close()
  console.log(`db: ${files.length} runs -> ${file}`)
}

function runId() {
  return process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}` : `local-${Date.now()}`
}

function secrets() {
  return SECRET_ENV.map((k) => process.env[k]).filter((v): v is string => !!v)
}

function runLink() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env
  return GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : 'local run'
}

const [command, ...args] = process.argv.slice(2)
const commands: Record<string, () => void> = { guard, agent, publish, record, db: () => db(args[0] ?? '.') }
if (!commands[command]) {
  console.error(`usage: node src/cli.ts <${Object.keys(commands).join('|')}>`)
  process.exit(2)
}
commands[command]()
