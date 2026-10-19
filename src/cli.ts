// Each subcommand is one step of .github/workflows/run.yml. Steps share files in FACTORY_RUN_DIR,
// and a step whose stage does not apply to this run does nothing.
//   guard           decide whether the issue event starts a run, find the approved plan   (github.token)
//   agent <round>   round 0: the spec or implement agent; round 1: implement again after a review asks for changes   (model key only)
//   publish <round> post the plan, or copy the agent's tree into a fresh clone and open or update the PR   (FACTORY_GH_TOKEN)
//   review <round>  run the review agent on the tree that round published   (model key only)
//   respond <round> post that review on the PR   (FACTORY_GH_TOKEN)
//   record          push the run record and scrubbed transcripts   (FACTORY_GH_TOKEN)
//   db              build runs.sqlite from a local factory-runs checkout
//   report          build report.html from a local factory-runs checkout   (your gh login)
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadAgent, parseVerdict } from './agents.ts'
import { approvedSpec, decide, SPEC_MARKER, type IssueComment } from './guard.ts'
import { credential, harnesses } from './harnesses.ts'
import { prOutcome, renderReport, type PrView, type ReportModel } from './report.ts'
import { scrub } from './scrub.ts'
import type { AgentName, Issue, Plan, PublishResult, ReportRow, RunRecord, RunStatus, StageResult, StageRun } from './types.ts'

const SECRET_ENV = [...Object.values(harnesses).flatMap((h) => h.credentials.map((c) => c.env)), 'FACTORY_GH_TOKEN']
// Five stages at most, inside the job's 240-minute timeout.
const AGENT_TIMEOUT_MS = 40 * 60 * 1000

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

const readPlan = () => readJson<Plan>('plan.json')!
const stageName = (agent: AgentName, round: number) => `${agent}-${round}`
const stage = (agent: AgentName, round: number) => readJson<StageResult>(`${stageName(agent, round)}.json`)
const published = (round: number) => readJson<PublishResult>(`publish-${round}.json`)
// A revise round runs only when the round before it pushed a commit and its review asked for changes.
const revising = (plan: Plan, round: number) =>
  round > 0 && plan.kind === 'implement' && !!published(round - 1)?.sha && stage('review', round - 1)?.verdict === 'request_changes'
const usd = (n: number | null) => (n === null ? 'n/a' : `$${n.toFixed(2)}`)
const about = (s: StageResult) => `\`${s.agent}\` on ${s.harness} (\`${s.model}\`), ${usd(s.usage.costUsd)}, ${s.wallTimeS}s`
const issueSection = (issue: Issue) => `## Issue #${issue.number}: ${issue.title}\n\n${issue.body}`

function guard() {
  const decision = decide(JSON.parse(readFileSync(env('GITHUB_EVENT_PATH'), 'utf8')))
  if (!decision.run) {
    console.log(`skip: ${decision.reason}`)
    setOutput('run', 'false')
    return
  }
  const { kind, issue, harness, task } = decision.plan
  let spec: string | null = null
  if (kind === 'implement') {
    const pages: IssueComment[][] = JSON.parse(sh('gh', ['api', '--paginate', '--slurp', `repos/${issue.repo}/issues/${issue.number}/comments`], { maxBuffer: 64 * 1024 * 1024 }))
    spec = approvedSpec(pages.flat(), issue.repo.split('/')[0])
  }
  mkdirSync(runDir(), { recursive: true })
  const plan: Plan = { ...decision.plan, spec, runId: runId() }
  writeJson('plan.json', plan)
  console.log(`run: ${kind} ${issue.repo}#${issue.number} harness=${harness ?? 'default'} plan=${spec ? 'approved' : 'none'} task=${task ?? 'none'}`)
  setOutput('run', 'true')
}

// Runs one agent in the factory image. The container sees its mounts and one model credential, nothing else.
function runStage(agent: AgentName, round: number, context: string, mounts: string[], baseSha: string) {
  const plan = readPlan()
  const def = loadAgent(factoryDir, agent)
  // A harness label compares implement harnesses, so spec and review stay on their own default.
  const harnessName = agent === 'implement' ? plan.harness ?? def.defaultHarness : def.defaultHarness
  const harness = harnesses[harnessName]
  const model = def.models[harnessName]
  const cred = credential(harnessName, process.env)
  if (!cred) throw new Error(`no credential for ${harnessName}: set ${harness.credentials.map((c) => c.env).join(' or ')}`)

  const name = stageName(agent, round)
  const startedAt = new Date().toISOString()
  const out = openSync(runFile(`${name}.jsonl`), 'w')
  const err = openSync(runFile(`${name}.stderr.txt`), 'w')
  console.log(`${name}: ${harnessName} (${model}), ${cred.billing} billing`)
  const r = spawnSync('docker', [
    'run', '--rm',
    '--user', `${process.getuid!()}:${process.getgid!()}`,
    '-e', 'HOME=/tmp/home',
    '-e', cred.env,
    ...mounts.flatMap((m) => ['-v', m]), '-w', '/work',
    process.env.FACTORY_IMAGE ?? 'factory-agent',
    ...harness.command(model, context ? `${def.prompt}\n\n${context}` : def.prompt),
  ], { stdio: ['ignore', out, err], timeout: AGENT_TIMEOUT_MS })
  closeSync(out)
  closeSync(err)

  const transcript = harness.parse(readFileSync(runFile(`${name}.jsonl`), 'utf8'))
  const ok = transcript.ok && r.status === 0
  const result: StageResult = {
    agent,
    round,
    harness: harnessName,
    model: transcript.model ?? model,
    billing: cred.billing,
    ok,
    verdict: agent === 'review' && ok ? parseVerdict(transcript.finalText) : null,
    usage: transcript.usage,
    startedAt,
    wallTimeS: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
    finalText: transcript.finalText,
    baseSha,
  }
  writeJson(`${name}.json`, result)
  console.log(`${name}: exit=${r.status ?? r.signal} ok=${ok}${agent === 'review' ? ` verdict=${result.verdict}` : ''} cost=${result.usage.costUsd ?? 'n/a'} time=${result.wallTimeS}s`)
  if (!ok) console.log(scrub(readFileSync(runFile(`${name}.stderr.txt`), 'utf8'), secrets()).split('\n').slice(-20).join('\n'))
}

function implementContext(plan: Plan, review: string | null) {
  return [
    issueSection(plan.issue),
    plan.spec && `## Approved plan\n\n${plan.spec}`,
    review && `## Review findings\n\n${scrub(review, secrets())}`,
  ].filter(Boolean).join('\n\n')
}

function agent(round: number) {
  const plan = readPlan()
  const work = resolve(env('FACTORY_WORK_DIR'))
  if (round === 0) {
    const baseSha = sh('git', ['-C', work, 'rev-parse', 'HEAD'])
    if (plan.kind === 'spec') return runStage('spec', 0, issueSection(plan.issue), [`${work}:/work:ro`], baseSha)
    return runStage('implement', 0, implementContext(plan, null), [`${work}:/work`], baseSha)
  }
  if (!revising(plan, round)) return console.log(`agent ${round}: no revise round`)
  // The work tree still holds the previous round's change, so this round edits on top of it.
  runStage('implement', round, implementContext(plan, stage('review', round - 1)!.finalText), [`${work}:/work`], stage('implement', 0)!.baseSha)
}

type Target = { issue: Issue } | { pr: string }

// Posts a comment, scrubbed. A body that gitleaks still flags is replaced by a notice.
// Returns whether the body went out as written.
function post(target: Target, body: string): boolean {
  const text = scrub(body, secrets())
  const clean = !hasLeak(text)
  writeFileSync(runFile('comment.md'), clean ? text : `A factory comment was withheld because gitleaks flagged a possible secret in it. [Run log](${runLink()})`)
  const where = 'pr' in target ? ['pr', 'comment', target.pr] : ['issue', 'comment', String(target.issue.number), '--repo', target.issue.repo]
  sh('gh', [...where, '--body-file', runFile('comment.md')], { env: { ...process.env, GH_TOKEN: env('FACTORY_GH_TOKEN') } })
  return clean
}

function publish(round: number) {
  const plan = readPlan()
  if (round > 0 && !revising(plan, round)) return console.log(`publish ${round}: no revise round`)
  if (plan.kind === 'spec') return publishSpec(plan)
  publishChange(plan, round)
}

function publishSpec(plan: Plan) {
  const result = stage('spec', 0)
  const done = (status: RunStatus) => {
    writeJson('publish-0.json', { status, branch: null, prUrl: null, sha: null } satisfies PublishResult)
    console.log(`publish 0: ${status}`)
  }
  if (!result?.ok || !result.finalText.trim()) {
    const what = result ? `The ${result.harness} spec agent did not finish with a plan` : 'The agent step crashed before the spec agent finished'
    done('agent_failed')
    post({ issue: plan.issue }, `${what}, so no plan was posted. [Run log](${runLink()})`)
    return
  }
  done(post({ issue: plan.issue }, `${SPEC_MARKER}\n\n${result.finalText.trim()}`) ? 'spec_posted' : 'blocked_secret')
}

// Round 0 opens the pull request. A revise round pushes one more commit to its branch.
function publishChange(plan: Plan, round: number) {
  const result = stage('implement', round)
  const prev = round > 0 ? published(round - 1)! : null
  const token = env('FACTORY_GH_TOKEN')
  const { repo, number } = plan.issue
  const runUrl = runLink()
  const target: Target = prev ? { pr: prev.prUrl! } : { issue: plan.issue }
  const nothing = prev ? 'so the pull request was not updated' : 'so no pull request was opened'
  const done = (status: RunStatus, message: string, pushed: Partial<PublishResult> = {}) => {
    const p: PublishResult = { status, branch: prev?.branch ?? null, prUrl: prev?.prUrl ?? null, sha: null, ...pushed }
    writeJson(`publish-${round}.json`, p)
    post(target, message)
    console.log(`publish ${round}: ${status}${p.prUrl ? ` ${p.prUrl}` : ''}`)
  }

  if (!result?.ok) {
    const what = result ? `The ${result.harness} agent did not finish successfully` : 'The agent step crashed before the agent finished'
    return done('agent_failed', `${what}, ${nothing}. [Run log](${runUrl})`)
  }

  // A fresh clone the agent never touched, so nothing it planted in .git (hooks, config) runs here.
  const pub = runFile('pub')
  rmSync(pub, { recursive: true, force: true })
  sh('git', ['clone', '--quiet', `https://x-access-token:${token}@github.com/${repo}.git`, pub])
  const baseSha = stage('implement', 0)!.baseSha
  const branch = prev?.branch ?? `factory/issue-${number}-${plan.runId}`
  sh('git', ['-C', pub, 'checkout', '--quiet', '-b', branch, prev ? `origin/${branch}` : baseSha])
  // --checksum: an edit that keeps a file's size within the clone's second would pass rsync's size-and-mtime check.
  sh('rsync', ['-a', '--checksum', '--delete', '--exclude=.git', `${resolve(env('FACTORY_WORK_DIR'))}/`, `${pub}/`])
  sh('git', ['-C', pub, 'add', '-A'])

  const changed = sh('git', ['-C', pub, 'diff', '--cached', '--name-only']).split('\n').filter(Boolean)
  if (changed.length === 0) {
    return done('no_changes', `The agent finished without changing any files, ${nothing}.\n\n> ${result.finalText.slice(0, 1500)}\n\n[Run log](${runUrl})`)
  }
  if (changed.some((f) => f.startsWith('.github/'))) {
    return done('blocked_workflow_change', `Blocked: the agent changed files under \`.github/\`, which the factory never pushes. [Run log](${runUrl})`)
  }
  const footer = `---\nfactory run: ${about(result)}. [Run log](${runUrl})`
  const body = scrub(prev ? `Revised after review.\n\n${result.finalText}\n\n${footer}` : `${result.finalText}\n\nCloses #${number}.\n\n${footer}`, secrets())
  if (hasLeak(sh('git', ['-C', pub, 'diff', '--cached'], { maxBuffer: 64 * 1024 * 1024 }) + '\n' + body)) {
    return done('blocked_secret', `Blocked: gitleaks flagged a possible secret in the agent's changes or summary, so nothing was pushed. [Run log](${runUrl})`)
  }

  const git = (...args: string[]) => sh('git', ['-C', pub, '-c', 'core.hooksPath=/dev/null', ...args], { maxBuffer: 64 * 1024 * 1024 })
  git('-c', 'user.name=factory', '-c', 'user.email=factory@users.noreply.github.com',
    'commit', '--quiet', '-m', prev ? `Address review of #${number}` : `${plan.issue.title}\n\nResolves #${number}.`)
  git('push', '--quiet', ...(prev ? [] : ['--force']), 'origin', branch)
  const sha = git('rev-parse', 'HEAD')
  writeFileSync(runFile(`diff-${round}.patch`), git('diff', baseSha, 'HEAD') + '\n')

  if (prev) return done('pr_opened', body, { sha })
  writeFileSync(runFile('pr-body.md'), body)
  const prUrl = sh('gh', ['pr', 'create', '--repo', repo, '--base', plan.baseBranch, '--head', branch, '--title', plan.issue.title, '--body-file', runFile('pr-body.md')], { env: { ...process.env, GH_TOKEN: token } })
  done('pr_opened', `Opened ${prUrl}`, { branch, prUrl, sha })
}

function review(round: number) {
  const plan = readPlan()
  if (plan.kind !== 'implement' || !published(round)?.sha) return console.log(`review ${round}: round ${round} pushed nothing to review`)
  const input = runFile(`review-${round}-input`)
  const tree = runFile(`review-${round}-tree`)
  for (const dir of [input, tree]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir)
  }
  writeFileSync(join(input, 'issue.md'), `# Issue #${plan.issue.number}: ${plan.issue.title}\n\n${plan.issue.body}\n`)
  if (plan.spec) writeFileSync(join(input, 'plan.md'), `${plan.spec}\n`)
  copyFileSync(runFile(`diff-${round}.patch`), join(input, 'diff.patch'))
  // The published tree without .git, whose remote URL holds the GitHub token. The review's edits land in this copy and are dropped.
  sh('rsync', ['-a', '--exclude=.git', `${runFile('pub')}/`, `${tree}/`])
  runStage('review', round, '', [`${tree}:/work`, `${input}:/input:ro`], stage('implement', 0)!.baseSha)
}

function respond(round: number) {
  const result = stage('review', round)
  const prUrl = published(round)?.prUrl
  if (!result || !prUrl) return console.log(`respond ${round}: no review to post`)
  const text = result.ok && result.finalText.trim() ? result.finalText.trim() : 'The review agent did not finish successfully, so this round has no review.'
  post({ pr: prUrl }, `${text}\n\n---\nfactory review, round ${round}: **${result.verdict ?? 'no verdict'}**. ${about(result)}. [Run log](${runLink()})`)
  console.log(`respond ${round}: posted the review (${result.verdict ?? 'no verdict'}) on ${prUrl}`)
}

function record() {
  const plan = readPlan()
  const token = env('FACTORY_GH_TOKEN')
  const id = plan.runId

  const results = readdirSync(runDir())
    .filter((f) => /^(spec|implement|review)-\d+\.json$/.test(f))
    .map((f) => readJson<StageResult>(f)!)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const transcripts = new Map<string, string>()
  const stages = results.map(({ finalText, baseSha, ...s }): StageRun => {
    const name = stageName(s.agent, s.round)
    const raw = existsSync(runFile(`${name}.jsonl`)) ? readFileSync(runFile(`${name}.jsonl`), 'utf8') : ''
    const text = scrub(raw, secrets())
    const stored = text.length > 0 && !hasLeak(text)
    if (stored) transcripts.set(name, text)
    return { ...s, transcript: stored ? 'stored' : 'withheld' }
  })

  const main = results.find((s) => s.agent === plan.kind && s.round === 0)
  const def = loadAgent(factoryDir, plan.kind)
  const harness = main?.harness ?? (plan.kind === 'implement' ? plan.harness : null) ?? def.defaultHarness
  const opened = published(0)
  const total = (pick: (s: StageRun) => number) => stages.reduce((n, s) => n + pick(s), 0)
  const costs = stages.map((s) => s.usage.costUsd).filter((c): c is number => c !== null)
  const rec: RunRecord = {
    id,
    startedAt: stages[0]?.startedAt ?? new Date().toISOString(),
    trigger: `issue#${plan.issue.number}`,
    factorySha: sh('git', ['-C', factoryDir, 'rev-parse', 'HEAD']),
    kind: plan.kind,
    task: plan.task,
    issueNumber: plan.issue.number,
    harness,
    model: main?.model ?? def.models[harness],
    repo: plan.issue.repo,
    baseSha: main?.baseSha ?? '',
    branch: opened?.branch ?? null,
    prUrl: opened?.prUrl ?? null,
    status: opened?.status ?? (main?.ok ? 'publish_failed' : 'agent_failed'),
    verdict: stages.findLast((s) => s.agent === 'review')?.verdict ?? null,
    stages,
    inputTokens: total((s) => s.usage.inputTokens),
    cacheReadTokens: total((s) => s.usage.cacheReadTokens),
    outputTokens: total((s) => s.usage.outputTokens),
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    wallTimeS: total((s) => s.wallTimeS),
    runUrl: runLink(),
  }

  const runsRepo = `${plan.issue.repo.split('/')[0]}/factory-runs`
  const dir = runFile('runs-repo')
  rmSync(dir, { recursive: true, force: true })
  sh('git', ['clone', '--quiet', '--depth', '1', `https://x-access-token:${token}@github.com/${runsRepo}.git`, dir])
  mkdirSync(join(dir, 'runs'), { recursive: true })
  mkdirSync(join(dir, 'transcripts', id), { recursive: true })
  writeFileSync(join(dir, 'runs', `${id}.json`), JSON.stringify(rec, null, 2) + '\n')
  for (const [name, text] of transcripts) writeFileSync(join(dir, 'transcripts', id, `${name}.jsonl`), text)

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
  console.log(`record: ${id} ${rec.status} verdict=${rec.verdict} stages=${stages.map((s) => `${stageName(s.agent, s.round)}:${s.transcript}`).join(',')} cost=${rec.costUsd ?? 'n/a'}`)
}

function readRecords(runsRepoDir: string): RunRecord[] {
  return readdirSync(join(runsRepoDir, 'runs'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(runsRepoDir, 'runs', f), 'utf8')))
}

function db(runsRepoDir: string) {
  const file = join(runsRepoDir, 'runs.sqlite')
  rmSync(file, { force: true })
  const database = new DatabaseSync(file)
  database.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY, started_at TEXT, trigger TEXT, factory_sha TEXT, kind TEXT, task TEXT, issue_number INTEGER,
    harness TEXT, model TEXT, repo TEXT, base_sha TEXT, branch TEXT, pr_url TEXT, status TEXT, verdict TEXT,
    input_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, wall_time_s INTEGER, run_url TEXT)`)
  database.exec(`CREATE TABLE stages (
    run_id TEXT REFERENCES runs(id), agent TEXT, round INTEGER, harness TEXT, model TEXT, billing TEXT, ok INTEGER, verdict TEXT,
    input_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, started_at TEXT, wall_time_s INTEGER,
    transcript TEXT, PRIMARY KEY (run_id, agent, round))`)
  const insertRun = database.prepare(`INSERT INTO runs VALUES (${Array(21).fill('?').join(', ')})`)
  const insertStage = database.prepare(`INSERT INTO stages VALUES (${Array(15).fill('?').join(', ')})`)
  const records = readRecords(runsRepoDir)
  for (const r of records) {
    insertRun.run(r.id, r.startedAt, r.trigger, r.factorySha, r.kind, r.task, r.issueNumber, r.harness, r.model, r.repo, r.baseSha,
      r.branch, r.prUrl, r.status, r.verdict, r.inputTokens, r.cacheReadTokens, r.outputTokens, r.costUsd, r.wallTimeS, r.runUrl)
    for (const s of r.stages) {
      insertStage.run(r.id, s.agent, s.round, s.harness, s.model, s.billing, s.ok ? 1 : 0, s.verdict, s.usage.inputTokens,
        s.usage.cacheReadTokens, s.usage.outputTokens, s.usage.costUsd, s.startedAt, s.wallTimeS, s.transcript)
    }
  }
  database.close()
  console.log(`db: ${records.length} runs -> ${file}`)
}

function report(runsRepoDir: string) {
  const records = readRecords(runsRepoDir)

  const rows: ReportRow[] = records.map((r) => {
    if (!r.prUrl) return { ...r, outcome: null, humanTouches: null }
    try {
      const pr: PrView = JSON.parse(sh('gh', ['pr', 'view', r.prUrl, '--json', 'state,mergedAt,comments,reviews,commits'], { maxBuffer: 64 * 1024 * 1024 }))
      const ref = `${r.repo}#${r.prUrl.split('/').pop()}`
      const reverted = pr.state === 'MERGED' &&
        sh('gh', ['api', '-X', 'GET', 'search/issues', '-f', `q=repo:${r.repo} is:pr is:merged "Reverts ${ref}" in:body`, '-q', '.total_count']) !== '0'
      return { ...r, ...prOutcome(r.repo, pr, reverted) }
    } catch (e) {
      console.log(`report: warning: could not look up ${r.prUrl}: ${(e as Error).message.split('\n')[0]}`)
      return { ...r, outcome: null, humanTouches: null }
    }
  })

  const steps: ReportModel['steps'] = {}
  for (const r of records) {
    steps[r.id] = {}
    for (const s of r.stages) {
      const name = stageName(s.agent, s.round)
      const file = join(runsRepoDir, 'transcripts', r.id, `${name}.jsonl`)
      steps[r.id][name] = null
      if (s.transcript !== 'stored' || !existsSync(file)) continue
      try {
        steps[r.id][name] = harnesses[s.harness].steps(readFileSync(file, 'utf8'))
      } catch (e) {
        console.log(`report: warning: could not read the ${name} transcript of ${r.id}: ${(e as Error).message}`)
      }
    }
  }

  const file = join(runsRepoDir, 'report.html')
  writeFileSync(file, renderReport({ generatedAt: new Date().toISOString(), rows, steps }))
  console.log(`report: ${rows.length} runs -> ${file}`)
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
const round = () => {
  if (args[0] !== '0' && args[0] !== '1') throw new Error(`${command}: round must be 0 or 1, got "${args[0]}"`)
  return Number(args[0])
}
const commands: Record<string, () => void> = {
  guard,
  agent: () => agent(round()),
  publish: () => publish(round()),
  review: () => review(round()),
  respond: () => respond(round()),
  record,
  db: () => db(args[0] ?? '.'),
  report: () => report(args[0] ?? '.'),
}
if (!commands[command]) {
  console.error(`usage: node src/cli.ts <${Object.keys(commands).join('|')}>`)
  process.exit(2)
}
commands[command]()
