// Each subcommand is one step of .github/workflows/run.yml. Steps share files in FACTORY_RUN_DIR,
// and a step whose stage does not apply to this run does nothing.
//   guard           decide whether the issue event starts a run, find the approved plan   (github.token)
//   preflight       check FACTORY_GH_TOKEN can push to the repo and factory-runs before any model is paid   (FACTORY_GH_TOKEN)
//   agent <round>   round 0: the spec or implement agent; round 1: implement again after a review asks for changes   (model key only)
//   publish <round> post the plan, or copy the agent's tree into a fresh clone and open or update the PR   (FACTORY_GH_TOKEN)
//   review <round>  run the review agent on the tree that round published   (model key only)
//   respond <round> post that review on the PR   (FACTORY_GH_TOKEN)
//   record          push the run record and scrubbed transcripts   (FACTORY_GH_TOKEN)
// .github/workflows/score.yml grades recorded runs:
//   score-prepare   find unscored runs and bench cells and write one job dir per (subject, scorer) with the evidence   (FACTORY_GH_TOKEN)
//   score-judge     run the correctness check and the judges in each job dir   (model keys only)
//   score-save      push the scores and scrubbed judge transcripts   (FACTORY_GH_TOKEN)
// .github/workflows/bench.yml replays bench tasks across harness:model configs:
//   bench-run       run the implement agent on each task x config, keep its diff, and grade the tree   (model keys only)
//   bench-save      push the results, scrubbed transcripts and diffs   (FACTORY_GH_TOKEN)
// .github/workflows/improve.yml asks the improve agent for a change to the factory's own prompts:
//   improve-prepare write findings.md from factory-runs and keep a copy of the untouched factory checkout   (FACTORY_GH_TOKEN)
//   improve-run     run the improve agent on the factory checkout with findings.md   (model keys only)
//   improve-save    diff the checkout, gate its scope, and push the improvement   (FACTORY_GH_TOKEN)
// Local:
//   db              build runs.sqlite from a local factory-runs checkout
//   report          build report.html from a local factory-runs checkout   (your gh login)
//   findings        print the findings.md the improve agent would read from a local factory-runs checkout
//   propose         open a pull request on the factory checkout you run it in from a proposed improvement   (your gh login)
//   models          check that every pi model in agents/ and scorers/ is in the image's catalog   (CI, no keys)
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cellName, parseConfigs, parseTask } from './bench.ts'
import { loadAgent, loadAgents, parseScore, parseVerdict } from './agents.ts'
import { approvedSpec, decide, splitBenchMarker, SPEC_MARKER, type IssueComment } from './guard.ts'
import { credential, harnesses } from './harnesses.ts'
import { basis, findingsMarkdown, headline, patchProblems, type Evidence } from './improve.ts'
import { prOutcome, renderReport, type PrView, type ReportModel } from './report.ts'
import {
  benchEvidence, benchSubject, CORRECTNESS, diffAndGrade, gradeTree, judgeEvidence, pendingBenchScores, pendingScores, scorePath, type JudgeEvidence,
} from './score.ts'
import { scrub } from './scrub.ts'
import {
  isHarnessName, type AgentName, type BenchResult, type Billing, type HarnessName, type Improvement, type ImprovementStatus, type Issue, type Plan,
  type PublishResult, type ReportRow, type RunRecord, type RunStatus, type Score, type ScoreSubject, type StageResult, type StageRun, type Transcript,
} from './types.ts'

const SECRET_ENV = [...Object.values(harnesses).flatMap((h) => h.credentials.map((c) => c.env)), 'FACTORY_GH_TOKEN']
// Five stages at most, inside the job's 240-minute timeout.
const AGENT_TIMEOUT_MS = 40 * 60 * 1000

const factoryDir = resolve(dirname(new URL(import.meta.url).pathname), '..')
const agentsDir = join(factoryDir, 'agents')
const scorersDir = join(factoryDir, 'scorers')
const tasksDir = join(factoryDir, 'bench', 'tasks')
const checkFile = (task: string) => join(tasksDir, task, 'check.test.js')
const FACTORY_EMAIL = 'factory@users.noreply.github.com'
const image = () => process.env.FACTORY_IMAGE ?? 'factory-agent'
const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}
const runDir = () => env('FACTORY_RUN_DIR')
const runFile = (name: string) => join(runDir(), name)
const readJson = <T>(name: string): T | null => (existsSync(runFile(name)) ? JSON.parse(readFileSync(runFile(name), 'utf8')) : null)
const writeJson = (name: string, value: unknown) => writeFileSync(runFile(name), JSON.stringify(value, null, 2) + '\n')
const readJsonFile = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8'))
const writeJsonFile = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const subdirs = (dir: string) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [])

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

// The token's repository access is only exercised after the agent has run and been paid for, so prove it first.
function preflight() {
  const { issue } = readPlan()
  const ghEnv = { ...process.env, GH_TOKEN: env('FACTORY_GH_TOKEN') }
  for (const repo of [issue.repo, `${issue.repo.split('/')[0]}/factory-runs`]) {
    const r = spawnSync('gh', ['api', `repos/${repo}`, '-q', '.permissions.push'], { encoding: 'utf8', env: ghEnv })
    if (r.stdout.trim() !== 'true') throw new Error(`FACTORY_GH_TOKEN cannot reach ${repo}: add the repo to the token's repository access`)
  }
  console.log(`preflight: FACTORY_GH_TOKEN can push to ${issue.repo} and its factory-runs`)
}

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

const docker = (mounts: string[], flags: string[]) => [
  'docker', 'run', '--rm',
  '--user', `${process.getuid!()}:${process.getgid!()}`,
  '-e', 'HOME=/tmp/home',
  ...flags,
  ...mounts.flatMap((m) => ['-v', m]), '-w', '/work',
  image(),
]
// The bench check runs the agent's code, so it gets no network and no credentials.
const sandbox = (tree: string) => docker([`${tree}:/work`], ['--network', 'none'])

type Launch = { harness: HarnessName; model: string; prompt: string; mounts: string[]; log: string }
type Launched = { transcript: Transcript; ok: boolean; billing: Billing; startedAt: string; wallTimeS: number }

// Runs one agent in the factory image. The container sees its mounts and one model credential, nothing else.
// The raw transcript goes to <log>.jsonl and the CLI's stderr to <log>.stderr.txt.
function runAgent(name: string, { harness: harnessName, model, prompt, mounts, log }: Launch): Launched {
  const harness = harnesses[harnessName]
  const cred = credential(harnessName, process.env)
  if (!cred) throw new Error(`no credential for ${harnessName}: set ${harness.credentials.map((c) => c.env).join(' or ')}`)

  const startedAt = new Date().toISOString()
  const out = openSync(`${log}.jsonl`, 'w')
  const err = openSync(`${log}.stderr.txt`, 'w')
  console.log(`${name}: ${harnessName} (${model}), ${cred.billing} billing`)
  const [cmd, ...args] = [...docker(mounts, ['-e', cred.env]), ...harness.command(model, prompt)]
  const r = spawnSync(cmd, args, { stdio: ['ignore', out, err], timeout: AGENT_TIMEOUT_MS })
  closeSync(out)
  closeSync(err)

  const transcript = harness.parse(readFileSync(`${log}.jsonl`, 'utf8'))
  const ok = transcript.ok && r.status === 0
  const wallTimeS = Math.round((Date.now() - Date.parse(startedAt)) / 1000)
  console.log(`${name}: exit=${r.status ?? r.signal} ok=${ok} cost=${transcript.usage.costUsd ?? 'n/a'} time=${wallTimeS}s`)
  if (!ok) console.log(scrub(readFileSync(`${log}.stderr.txt`, 'utf8'), secrets()).split('\n').slice(-20).join('\n'))
  return { transcript, ok, billing: cred.billing, startedAt, wallTimeS }
}

function runStage(agent: AgentName, round: number, context: string, mounts: string[], baseSha: string) {
  const plan = readPlan()
  const def = loadAgent(agentsDir, agent)
  // A harness label compares implement harnesses, so spec and review stay on their own default.
  const harness = agent === 'implement' ? plan.harness ?? def.defaultHarness : def.defaultHarness
  const model = def.models[harness]
  const name = stageName(agent, round)
  const prompt = context ? `${def.prompt}\n\n${context}` : def.prompt
  const { transcript, ok, billing, startedAt, wallTimeS } = runAgent(name, { harness, model, prompt, mounts, log: runFile(name) })
  const result: StageResult = {
    agent,
    round,
    harness,
    model: transcript.model ?? model,
    billing,
    ok,
    verdict: agent === 'review' && ok ? parseVerdict(transcript.finalText) : null,
    usage: transcript.usage,
    startedAt,
    wallTimeS,
    finalText: transcript.finalText,
    baseSha,
  }
  writeJson(`${name}.json`, result)
  if (agent === 'review') console.log(`${name}: verdict=${result.verdict}`)
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
  git('-c', 'user.name=factory', '-c', `user.email=${FACTORY_EMAIL}`,
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
    const text = storable(raw)
    if (text) transcripts.set(name, text)
    return { ...s, transcript: text ? 'stored' : 'withheld' }
  })

  const main = results.find((s) => s.agent === plan.kind && s.round === 0)
  const def = loadAgent(agentsDir, plan.kind)
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

  const dir = cloneRunsRepo(token, plan.issue.repo.split('/')[0])
  mkdirSync(join(dir, 'runs'), { recursive: true })
  mkdirSync(join(dir, 'transcripts', id), { recursive: true })
  writeFileSync(join(dir, 'runs', `${id}.json`), JSON.stringify(rec, null, 2) + '\n')
  for (const [name, text] of transcripts) writeFileSync(join(dir, 'transcripts', id, `${name}.jsonl`), text)
  if (!pushRunsRepo(dir, `run ${id}: ${rec.status} ${rec.repo}#${plan.issue.number}`)) return console.log(`record: ${id} already recorded`)
  console.log(`record: ${id} ${rec.status} verdict=${rec.verdict} stages=${stages.map((s) => `${stageName(s.agent, s.round)}:${s.transcript}`).join(',')} cost=${rec.costUsd ?? 'n/a'}`)
}

function cloneRunsRepo(token: string, owner: string): string {
  const dir = runFile('runs-repo')
  rmSync(dir, { recursive: true, force: true })
  sh('git', ['clone', '--quiet', '--depth', '1', `https://x-access-token:${token}@github.com/${owner}/factory-runs.git`, dir])
  return dir
}

// Commits everything in the runs clone and pushes it. Returns false when there was nothing new to push.
function pushRunsRepo(dir: string, message: string): boolean {
  const git = (...args: string[]) => sh('git', ['-C', dir, '-c', 'user.name=factory', '-c', `user.email=${FACTORY_EMAIL}`, ...args])
  git('add', '-A')
  if (git('status', '--porcelain') === '') return false
  git('commit', '--quiet', '-m', message)
  // Every writer adds only its own files, so a rebase onto another writer's push never conflicts.
  for (let attempt = 1; ; attempt++) {
    const push = spawnSync('git', ['-C', dir, 'push', '--quiet', 'origin', 'HEAD'], { encoding: 'utf8' })
    if (push.status === 0) return true
    if (attempt === 5) throw new Error(`push to factory-runs failed 5 times: ${push.stderr}`)
    git('pull', '--quiet', '--rebase', 'origin', sh('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']))
  }
}

// Scrubs a transcript and checks it with gitleaks. null means it must not be stored.
function storable(raw: string): string | null {
  const text = scrub(raw, secrets())
  return text.length > 0 && !hasLeak(text) ? text : null
}

// What score-prepare leaves in each job dir for score-judge.
type ScoreJob = { subject: ScoreSubject; scorer: string; task: string | null; sha: string }
const scoreJobs = () => runFile('score')

function scorePrepare() {
  const token = env('FACTORY_GH_TOKEN')
  const runsDir = cloneRunsRepo(token, env('GITHUB_REPOSITORY_OWNER'))
  const scorers = [CORRECTNESS, ...loadAgents(scorersDir).map((j) => j.name)]
  if (scorers.slice(1).includes(CORRECTNESS)) throw new Error(`scorers/${CORRECTNESS}.md: that name belongs to the built-in check`)
  const existing = scoreFiles(runsDir)
  const pending = Map.groupBy(pendingScores(readRecords(runsDir), scorers, existing), (p) => p.run)
  const benchPending = Map.groupBy(pendingBenchScores(readNested<BenchResult>(runsDir, 'bench'), scorers, existing), (p) => p.cell)
  console.log(`score-prepare: ${[...pending.values()].flat().length} scores pending over ${pending.size} runs, ` +
    `${[...benchPending.values()].flat().length} over ${benchPending.size} bench cells`)

  const clones = new Map<string, string>()
  for (const [run, jobs] of pending) {
    try {
      const repo = clones.get(run.repo) ?? runFile(`repos/${run.repo.replace('/', '__')}`)
      if (!clones.has(run.repo)) {
        rmSync(repo, { recursive: true, force: true })
        sh('git', ['clone', '--quiet', `https://x-access-token:${token}@github.com/${run.repo}.git`, repo])
        clones.set(run.repo, repo)
      }
      const git = (...args: string[]) => sh('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 })
      // The PR ref outlives a deleted branch. The graded tree is the factory's last commit, not later human commits.
      git('fetch', '--quiet', 'origin', `pull/${run.prUrl!.split('/').pop()}/head`)
      const sha = git('log', '-1', '--format=%H', `--author=${FACTORY_EMAIL}`, `${run.baseSha}..FETCH_HEAD`)
      if (!sha) throw new Error('no factory commit on the PR')
      const issue: { title: string; body: string } = JSON.parse(sh('gh', ['issue', 'view', String(run.issueNumber), '--repo', run.repo, '--json', 'title,body'],
        { env: { ...process.env, GH_TOKEN: token } }))

      const subject: ScoreSubject = { kind: 'run', runId: run.id }
      for (const { scorer } of jobs) {
        const dir = scoreJobDir(subject, scorer)
        if (!dir) continue
        if (scorer === CORRECTNESS) {
          mkdirSync(join(dir, 'tree'), { recursive: true })
          sh('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', repo, sha, join(dir, 'tree')])
        } else {
          writeEvidence(dir, judgeEvidence({ title: issue.title, body: splitBenchMarker(issue.body).body }, git('diff', run.baseSha, sha),
            run.stages.filter((s) => s.agent === 'implement').map((s) => {
              const file = join(runsDir, 'transcripts', run.id, `${stageName(s.agent, s.round)}.jsonl`)
              const stored = s.transcript === 'stored' && existsSync(file)
              return { name: stageName(s.agent, s.round), steps: stored ? harnesses[s.harness].steps(readFileSync(file, 'utf8')) : null }
            })))
        }
        writeJsonFile(join(dir, 'job.json'), { subject, scorer, task: run.task, sha } satisfies ScoreJob)
      }
      console.log(`score-prepare: ${run.id} ${run.repo}#${run.issueNumber} at ${sha.slice(0, 7)}: ${jobs.map((j) => j.scorer).join(', ')}`)
    } catch (e) {
      console.log(`score-prepare: warning: skipped ${run.id}: ${(e as Error).message.split('\n')[0]}`)
    }
  }

  for (const [cell, jobs] of benchPending) {
    const subject = benchSubject(cell)
    try {
      const evidence = benchEvidence(runsDir, tasksDir, cell)
      for (const { scorer } of jobs) {
        const dir = scoreJobDir(subject, scorer)
        if (!dir) continue
        writeEvidence(dir, evidence)
        writeJsonFile(join(dir, 'job.json'), { subject, scorer, task: cell.task, sha: cell.baseSha } satisfies ScoreJob)
      }
      console.log(`score-prepare: bench ${cell.benchId} ${subject.cell}: ${jobs.map((j) => j.scorer).join(', ')}`)
    } catch (e) {
      console.log(`score-prepare: warning: skipped bench ${cell.benchId} ${subject.cell}: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  // These clones hold FACTORY_GH_TOKEN in their remote URL, and the next step must not see it.
  for (const dir of [runsDir, runFile('repos')]) rmSync(dir, { recursive: true, force: true })
}

const subjectName = (s: ScoreSubject) => (s.kind === 'run' ? s.runId : `bench ${s.benchId} ${s.cell}`)

// A fresh job dir for (subject, scorer), or null when a prepared job is already waiting there.
function scoreJobDir(subject: ScoreSubject, scorer: string): string | null {
  const dir = join(scoreJobs(), subject.kind === 'run' ? `${subject.runId}__${scorer}` : `bench__${subject.benchId}__${subject.cell}__${scorer}`)
  if (existsSync(join(dir, 'job.json'))) return null
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeEvidence(dir: string, files: JudgeEvidence) {
  mkdirSync(join(dir, 'evidence'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'evidence', name), text)
}

function scoreJudge() {
  const judges = new Map(loadAgents(scorersDir).map((j) => [j.name, j]))
  const factorySha = sh('git', ['-C', factoryDir, 'rev-parse', 'HEAD'])
  for (const name of subdirs(scoreJobs())) {
    const dir = join(scoreJobs(), name)
    if (existsSync(join(dir, 'score.json')) || !existsSync(join(dir, 'job.json'))) continue
    const job = readJsonFile<ScoreJob>(join(dir, 'job.json'))
    const base = { subject: job.subject, scorer: job.scorer, sha: job.sha, factorySha }
    try {
      let score: Score
      if (job.scorer === CORRECTNESS) {
        const tree = join(dir, 'tree')
        score = { ...base, ...gradeTree(tree, checkFile(job.task!), sandbox(tree)), at: new Date().toISOString(), judge: null }
      } else {
        const def = judges.get(job.scorer)
        if (!def) throw new Error(`no scorers/${job.scorer}.md`)
        const harness = def.defaultHarness
        const run = runAgent(name, { harness, model: def.models[harness], prompt: def.prompt, mounts: [`${join(dir, 'evidence')}:/work:ro`], log: join(dir, 'judge') })
        // A judge that crashed says nothing about the run, so the job stays pending instead of saving an unknown.
        if (!run.ok) throw new Error('the judge did not finish')
        const text = run.transcript.finalText.trim()
        score = {
          ...base,
          pass: parseScore(text),
          reason: text.length > 2000 ? `${text.slice(0, 2000)}…` : text || 'The judge gave no reason.',
          at: new Date().toISOString(),
          judge: { harness, model: run.transcript.model ?? def.models[harness], billing: run.billing, costUsd: run.transcript.usage.costUsd, wallTimeS: run.wallTimeS },
        }
      }
      writeJsonFile(join(dir, 'score.json'), score)
      console.log(`score-judge: ${subjectName(job.subject)} ${job.scorer}: ${score.pass === null ? 'unknown' : score.pass ? 'pass' : 'fail'}`)
    } catch (e) {
      console.log(`score-judge: warning: ${subjectName(job.subject)} ${job.scorer} not scored: ${(e as Error).message.split('\n')[0]}`)
      // The job stays pending for the next run, and the workflow shows it failed.
      process.exitCode = 1
    }
  }
}

function scoreSave() {
  const dir = cloneRunsRepo(env('FACTORY_GH_TOKEN'), env('GITHUB_REPOSITORY_OWNER'))
  let saved = 0
  for (const name of subdirs(scoreJobs())) {
    const job = join(scoreJobs(), name)
    if (!existsSync(join(job, 'score.json'))) continue
    const score = readJsonFile<Score>(join(job, 'score.json'))
    const target = join(dir, scorePath(score.subject, score.scorer))
    // A score is never recomputed or overwritten.
    if (existsSync(target)) continue
    mkdirSync(dirname(target), { recursive: true })
    const reason = scrub(score.reason, secrets())
    writeJsonFile(target, { ...score, reason: hasLeak(reason) ? 'The reason was withheld because gitleaks flagged a possible secret in it.' : reason })
    const transcript = existsSync(join(job, 'judge.jsonl')) ? storable(readFileSync(join(job, 'judge.jsonl'), 'utf8')) : null
    if (transcript) writeFileSync(target.replace(/\.json$/, '.jsonl'), transcript)
    saved++
  }
  if (!pushRunsRepo(dir, `scores: ${saved} new`)) return console.log('score-save: nothing new to save')
  console.log(`score-save: pushed ${saved} scores`)
}

const benchCells = () => runFile('bench')

function benchRun() {
  const configs = parseConfigs(env('BENCH_CONFIGS'))
  const known = subdirs(join(factoryDir, 'bench', 'tasks'))
  const wanted = env('BENCH_TASKS').trim()
  const tasks = wanted === 'all' ? known : wanted.split(',').map((t) => t.trim()).filter(Boolean)
  const unknown = tasks.filter((t) => !known.includes(t))
  if (unknown.length || !tasks.length) throw new Error(`unknown bench tasks: ${unknown.join(', ') || '(none given)'}; known: ${known.join(', ')}`)
  const base = resolve(env('FACTORY_WORK_DIR'))
  const baseSha = sh('git', ['-C', base, 'rev-parse', 'HEAD'])
  // The code, tasks and hidden checks come from this checkout; only the prompt under test comes from factory_ref, so any
  // proposal branch can be benched however far main has moved, and a branch can never change the checks it is graded by.
  const refDir = resolve(env('BENCH_FACTORY_REF_DIR'))
  const implement = loadAgent(join(refDir, 'agents'), 'implement')
  const fixed = { benchId: env('BENCH_ID'), factoryRef: env('FACTORY_REF'), factorySha: sh('git', ['-C', refDir, 'rev-parse', 'HEAD']), baseSha }
  mkdirSync(benchCells(), { recursive: true })
  console.log(`bench-run: ${fixed.benchId}: ${tasks.length} tasks x ${configs.length} configs, implement.md at ${fixed.factoryRef} (${fixed.factorySha.slice(0, 7)}), base ${baseSha.slice(0, 7)}`)

  for (const task of tasks) {
    const { title, body } = parseTask(readFileSync(join(factoryDir, 'bench', 'tasks', task, 'task.md'), 'utf8'))
    for (const config of configs) {
      const cell = cellName(task, config)
      if (existsSync(join(benchCells(), `${cell}.json`))) continue
      try {
        const work = join(benchCells(), cell, 'work')
        const tree = join(benchCells(), cell, 'tree')
        rmSync(join(benchCells(), cell), { recursive: true, force: true })
        mkdirSync(tree, { recursive: true })
        sh('rsync', ['-a', `${base}/`, `${work}/`])
        const prompt = `${implement.prompt}\n\n## Issue: ${title}\n\n${body}`
        const run = runAgent(cell, { ...config, prompt, mounts: [`${work}:/work`], log: join(benchCells(), cell) })
        sh('rsync', ['-a', '--exclude=.git', `${work}/`, `${tree}/`])
        const { diff, grade } = diffAndGrade(base, baseSha, tree, checkFile(task), sandbox(tree))
        writeFileSync(join(benchCells(), `${cell}.patch`), diff)
        const result: Omit<BenchResult, 'transcript' | 'diff'> = {
          ...fixed,
          task,
          harness: config.harness,
          requestedModel: config.model,
          model: run.transcript.model ?? config.model,
          billing: run.billing,
          pass: grade.pass,
          checkOutput: grade.reason,
          usage: run.transcript.usage,
          costUsd: run.transcript.usage.costUsd,
          wallTimeS: run.wallTimeS,
          at: run.startedAt,
        }
        writeJsonFile(join(benchCells(), `${cell}.json`), result)
        console.log(`bench-run: ${cell}: ${grade.pass === null ? 'unknown' : grade.pass ? 'pass' : 'fail'}`)
      } catch (e) {
        console.log(`bench-run: warning: ${cell} not run: ${(e as Error).message.split('\n')[0]}`)
        process.exitCode = 1
      }
    }
  }
}

function benchSave() {
  const dir = cloneRunsRepo(env('FACTORY_GH_TOKEN'), env('GITHUB_REPOSITORY_OWNER'))
  const files = existsSync(benchCells()) ? readdirSync(benchCells()).filter((f) => f.endsWith('.json')) : []
  let saved = 0
  for (const file of files) {
    const result = readJsonFile<Omit<BenchResult, 'transcript' | 'diff'>>(join(benchCells(), file))
    const target = join(dir, 'bench', result.benchId, file)
    if (existsSync(target)) continue
    mkdirSync(dirname(target), { recursive: true })
    const raw = join(benchCells(), file.replace(/\.json$/, '.jsonl'))
    const transcript = existsSync(raw) ? storable(readFileSync(raw, 'utf8')) : null
    if (transcript) writeFileSync(target.replace(/\.json$/, '.jsonl'), transcript)
    const patch = join(benchCells(), file.replace(/\.json$/, '.patch'))
    const diff = existsSync(patch) ? storable(readFileSync(patch, 'utf8')) : null
    if (diff) writeFileSync(target.replace(/\.json$/, '.patch'), diff)
    writeJsonFile(target, { ...result, transcript: transcript ? 'stored' : 'withheld', diff: diff ? 'stored' : 'withheld' } satisfies BenchResult)
    saved++
  }
  if (!pushRunsRepo(dir, `bench: ${saved} results`)) return console.log('bench-save: nothing new to save')
  console.log(`bench-save: pushed ${saved} results`)
}

// What improve-prepare leaves for the steps after it. No file means there was nothing to improve.
type ImproveState = { id: string; factorySha: string; basis: Improvement['basis'] }
type ImproveRun = { harness: HarnessName; model: string; ok: boolean; finalText: string; costUsd: number | null; wallTimeS: number; at: string }
const improveFile = (name: string) => join(runFile('improve'), name)

function readEvidence(runsRepoDir: string): Evidence {
  const records = readRecords(runsRepoDir)
  const reviews: Evidence['reviews'] = {}
  for (const r of records) {
    const s = r.stages.findLast((x) => x.agent === 'review')
    const file = s && join(runsRepoDir, 'transcripts', r.id, `${stageName(s.agent, s.round)}.jsonl`)
    if (s?.transcript === 'stored' && file && existsSync(file)) reviews[r.id] = harnesses[s.harness].parse(readFileSync(file, 'utf8')).finalText
  }
  return { records, scores: readScores(runsRepoDir), bench: readNested<BenchResult>(runsRepoDir, 'bench'), reviews }
}

function improvePrepare() {
  const work = resolve(env('FACTORY_WORK_DIR'))
  const runsDir = cloneRunsRepo(env('FACTORY_GH_TOKEN'), env('GITHUB_REPOSITORY_OWNER'))
  const evidence = readEvidence(runsDir)
  // The clone holds FACTORY_GH_TOKEN in its remote URL, and the agent step must not see it.
  rmSync(runsDir, { recursive: true, force: true })
  const b = basis(evidence)
  if (!b.failingScores && !evidence.bench.some((c) => c.pass === false)) {
    return console.log(`improve-prepare: ${b.runs} runs, ${b.scores} scores, no failing score or bench cell, so nothing to improve`)
  }
  rmSync(runFile('improve'), { recursive: true, force: true })
  mkdirSync(improveFile('input'), { recursive: true })
  writeFileSync(improveFile('input/findings.md'), findingsMarkdown(evidence))
  // The checkout before the agent touches it, .git included. improve-save diffs against this copy, so no git
  // command ever runs in a .git the agent could have changed.
  sh('rsync', ['-a', `${work}/`, `${improveFile('base')}/`])
  const state: ImproveState = { id: runId(), factorySha: sh('git', ['-C', work, 'rev-parse', 'HEAD']), basis: b }
  writeJsonFile(improveFile('state.json'), state)
  console.log(`improve-prepare: ${state.id} on ${state.factorySha.slice(0, 7)}: ${b.runs} runs, ${b.scores} scores (${b.failingScores} failing), benches ${b.benches.join(', ') || 'none'}`)
}

function improveRun() {
  if (!existsSync(improveFile('state.json'))) return console.log('improve-run: nothing to improve')
  // The definition comes from the factory code running this step, never from the checkout the agent edits.
  const def = loadAgent(agentsDir, 'improve')
  const harness = process.env.IMPROVE_HARNESS || def.defaultHarness
  if (!isHarnessName(harness)) throw new Error(`IMPROVE_HARNESS must be one of claude-code, pi, got "${harness}"`)
  const model = def.models[harness]
  const work = resolve(env('FACTORY_WORK_DIR'))
  const run = runAgent('improve', { harness, model, prompt: def.prompt, mounts: [`${work}:/work`, `${improveFile('input')}:/input:ro`], log: improveFile('improve') })
  writeJsonFile(improveFile('run.json'), {
    harness, model: run.transcript.model ?? model, ok: run.ok, finalText: run.transcript.finalText,
    costUsd: run.transcript.usage.costUsd, wallTimeS: run.wallTimeS, at: run.startedAt,
  } satisfies ImproveRun)
}

function improveSave() {
  if (!existsSync(improveFile('state.json'))) return console.log('improve-save: nothing to save')
  const state = readJsonFile<ImproveState>(improveFile('state.json'))
  const run = existsSync(improveFile('run.json')) ? readJsonFile<ImproveRun>(improveFile('run.json')) : null
  const def = loadAgent(agentsDir, 'improve')
  const files: Record<string, string> = { 'findings.md': readFileSync(improveFile('input/findings.md'), 'utf8') }
  let status: ImprovementStatus = 'agent_failed'
  let changedFiles: string[] = []
  if (run?.ok) {
    const base = improveFile('base')
    sh('rsync', ['-a', '--checksum', '--delete', '--exclude=.git', `${resolve(env('FACTORY_WORK_DIR'))}/`, `${base}/`])
    const git = (...args: string[]) => sh('git', ['-C', base, '-c', 'core.hooksPath=/dev/null', ...args], { maxBuffer: 64 * 1024 * 1024 })
    git('add', '-A')
    const patch = git('diff', '--cached', '--no-renames', '--no-color')
    changedFiles = git('diff', '--cached', '--no-renames', '--name-only').split('\n').filter(Boolean).map((f) => scrub(f, secrets()))
    const problems = patch ? patchProblems(patch) : []
    if (!patch) status = 'no_change'
    else if (problems.length) {
      status = 'blocked_scope'
      console.log(`improve-save: blocked: ${problems.join('; ')}`)
    } else if (scrub(patch, secrets()) !== patch || hasLeak(`${patch}\n${scrub(run.finalText, secrets())}`)) status = 'blocked_secret'
    else {
      status = 'proposed'
      files['patch.diff'] = `${patch}\n`
    }
  }
  // A blocked proposal keeps only its record and the evidence.
  if (status !== 'blocked_scope' && status !== 'blocked_secret') {
    const summary = scrub(run?.finalText.trim() ?? '', secrets())
    if (summary && !hasLeak(summary)) files['summary.md'] = `${summary}\n`
    const transcript = existsSync(improveFile('improve.jsonl')) ? storable(readFileSync(improveFile('improve.jsonl'), 'utf8')) : null
    if (transcript) files['improve.jsonl'] = transcript
  }
  const harness = run?.harness ?? def.defaultHarness
  const improvement: Improvement = {
    id: state.id,
    at: run?.at ?? new Date().toISOString(),
    factorySha: state.factorySha,
    basis: state.basis,
    harness,
    model: run?.model ?? def.models[harness],
    costUsd: run?.costUsd ?? null,
    wallTimeS: run?.wallTimeS ?? 0,
    changedFiles,
    status,
  }
  const dir = cloneRunsRepo(env('FACTORY_GH_TOKEN'), env('GITHUB_REPOSITORY_OWNER'))
  const target = join(dir, 'improvements', state.id)
  mkdirSync(target, { recursive: true })
  writeJsonFile(join(target, 'improvement.json'), improvement)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(target, name), text)
  if (!pushRunsRepo(dir, `improvement ${state.id}: ${status}`)) return console.log(`improve-save: ${state.id} already saved`)
  console.log(`improve-save: ${state.id} ${status} ${changedFiles.join(', ')} cost=${improvement.costUsd ?? 'n/a'}`)
}

// Run by the owner in their factory checkout, with their own gh login: the factory's token cannot write to this repo.
function propose(runsRepoDir: string, id: string) {
  const refuse = (why: string) => {
    console.error(`propose: refusing: ${why}`)
    process.exit(1)
  }
  const dir = resolve(runsRepoDir, 'improvements', id)
  if (!existsSync(join(dir, 'improvement.json'))) return refuse(`no improvement ${id} in ${runsRepoDir}`)
  const improvement = readJsonFile<Improvement>(join(dir, 'improvement.json'))
  if (improvement.status !== 'proposed') return refuse(`improvement ${id} is ${improvement.status}, so it has no patch to propose`)
  const patchFile = join(dir, 'patch.diff')
  const problems = patchProblems(readFileSync(patchFile, 'utf8'))
  if (problems.length) return refuse(`the patch changes more than the agent prompts in agents/: ${problems.join('; ')}`)
  const summary = readFileSync(join(dir, 'summary.md'), 'utf8').trim()
  const repo = sh('git', ['rev-parse', '--show-toplevel'])
  const git = (...args: string[]) => sh('git', ['-C', repo, ...args])
  if (git('status', '--porcelain')) return refuse('the working tree has uncommitted changes; commit or stash them first')

  const branch = `improve/${id}`
  git('fetch', '--quiet', 'origin')
  git('switch', '--quiet', '-c', branch, improvement.factorySha)
  try {
    git('apply', '--index', patchFile)
    const scopes = [...new Set(git('diff', '--cached', '--name-only').split('\n').map((f) => f.split('/')[0]))].sort()
    const subject = `feat(${scopes.join(',')}): ${headline(summary)}`
    // The summary's first line is the subject, so the body is the rest.
    const rest = summary.replace(/^.*\n?/, '').trim()
    git('commit', '--quiet', '-m', subject, ...(rest ? ['-m', rest] : []))
    git('push', '--quiet', '-u', 'origin', branch)
    const body = join(mkdtempSync(join(tmpdir(), 'propose-')), 'body.md')
    writeFileSync(body, `${rest}\n\n---\nProposed by the factory improve agent: improvement \`${id}\` in factory-runs holds the evidence it read and its transcript. ` +
      `Benchmark this branch with \`factory_ref: ${branch}\` before merging.\n`)
    const url = sh('gh', ['pr', 'create', '--head', branch, '--title', subject, '--body-file', body], { cwd: repo })
    console.log(`propose: ${branch}: ${url}`)
  } finally {
    git('checkout', '--quiet', '-')
  }
}

function readRecords(runsRepoDir: string): RunRecord[] {
  return readdirSync(join(runsRepoDir, 'runs'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(runsRepoDir, 'runs', f), 'utf8')))
}

// Every score file, as `scores/...` paths: run scores and bench cell scores alike.
function scoreFiles(runsRepoDir: string): string[] {
  const root = join(runsRepoDir, 'scores')
  return existsSync(root) ? readdirSync(root, { recursive: true, encoding: 'utf8' }).map((f) => `scores/${f}`).sort() : []
}

const readScores = (runsRepoDir: string) => scoreFiles(runsRepoDir).filter((f) => f.endsWith('.json')).map((f) => readJsonFile<Score>(join(runsRepoDir, f)))

// Files under <runs repo>/<kind>/<id>/*.json, such as bench/<benchId>/<cell>.json. A missing dir has none.
function readNested<T>(runsRepoDir: string, kind: 'bench' | 'improvements'): T[] {
  const root = join(runsRepoDir, kind)
  return subdirs(root).flatMap((id) => readdirSync(join(root, id)).filter((f) => f.endsWith('.json')).map((f) => readJsonFile<T>(join(root, id, f))))
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
  database.exec(`CREATE TABLE scores (
    run_id TEXT REFERENCES runs(id), bench_id TEXT, cell TEXT, scorer TEXT, pass INTEGER, reason TEXT, sha TEXT, factory_sha TEXT, at TEXT,
    judge_harness TEXT, judge_model TEXT, judge_billing TEXT, judge_cost_usd REAL, judge_wall_time_s INTEGER)`)
  database.exec(`CREATE TABLE bench (
    bench_id TEXT, task TEXT, harness TEXT, requested_model TEXT, model TEXT, factory_ref TEXT, factory_sha TEXT, base_sha TEXT,
    billing TEXT, pass INTEGER, check_output TEXT, input_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER,
    cost_usd REAL, wall_time_s INTEGER, at TEXT, transcript TEXT, diff TEXT, PRIMARY KEY (bench_id, task, harness, requested_model))`)
  database.exec(`CREATE TABLE improvements (
    id TEXT PRIMARY KEY, at TEXT, factory_sha TEXT, basis_runs INTEGER, basis_scores INTEGER, basis_failing_scores INTEGER, basis_benches TEXT,
    harness TEXT, model TEXT, cost_usd REAL, wall_time_s INTEGER, changed_files TEXT, status TEXT)`)
  const insertRun = database.prepare(`INSERT INTO runs VALUES (${Array(21).fill('?').join(', ')})`)
  const insertStage = database.prepare(`INSERT INTO stages VALUES (${Array(15).fill('?').join(', ')})`)
  const insertScore = database.prepare(`INSERT INTO scores VALUES (${Array(14).fill('?').join(', ')})`)
  const insertBench = database.prepare(`INSERT INTO bench VALUES (${Array(19).fill('?').join(', ')})`)
  const bool = (b: boolean | null) => (b === null ? null : b ? 1 : 0)
  const records = readRecords(runsRepoDir)
  for (const r of records) {
    insertRun.run(r.id, r.startedAt, r.trigger, r.factorySha, r.kind, r.task, r.issueNumber, r.harness, r.model, r.repo, r.baseSha,
      r.branch, r.prUrl, r.status, r.verdict, r.inputTokens, r.cacheReadTokens, r.outputTokens, r.costUsd, r.wallTimeS, r.runUrl)
    for (const s of r.stages) {
      insertStage.run(r.id, s.agent, s.round, s.harness, s.model, s.billing, s.ok ? 1 : 0, s.verdict, s.usage.inputTokens,
        s.usage.cacheReadTokens, s.usage.outputTokens, s.usage.costUsd, s.startedAt, s.wallTimeS, s.transcript)
    }
  }
  const scores = readScores(runsRepoDir)
  for (const s of scores) {
    const { subject: x } = s
    insertScore.run(x.kind === 'run' ? x.runId : null, x.kind === 'bench' ? x.benchId : null, x.kind === 'bench' ? x.cell : null, s.scorer, bool(s.pass), s.reason, s.sha, s.factorySha, s.at,
      s.judge?.harness ?? null, s.judge?.model ?? null, s.judge?.billing ?? null, s.judge?.costUsd ?? null, s.judge?.wallTimeS ?? null)
  }
  const bench = readNested<BenchResult>(runsRepoDir, 'bench')
  for (const b of bench) {
    insertBench.run(b.benchId, b.task, b.harness, b.requestedModel, b.model, b.factoryRef, b.factorySha, b.baseSha, b.billing, bool(b.pass),
      b.checkOutput, b.usage.inputTokens, b.usage.cacheReadTokens, b.usage.outputTokens, b.costUsd, b.wallTimeS, b.at, b.transcript, b.diff)
  }
  const improvements = readNested<Improvement>(runsRepoDir, 'improvements')
  const insertImprovement = database.prepare(`INSERT INTO improvements VALUES (${Array(13).fill('?').join(', ')})`)
  for (const i of improvements) {
    insertImprovement.run(i.id, i.at, i.factorySha, i.basis.runs, i.basis.scores, i.basis.failingScores, i.basis.benches.join(','),
      i.harness, i.model, i.costUsd, i.wallTimeS, JSON.stringify(i.changedFiles), i.status)
  }
  database.close()
  console.log(`db: ${records.length} runs, ${scores.length} scores, ${bench.length} bench results, ${improvements.length} improvements -> ${file}`)
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
  const scores = readScores(runsRepoDir)
  const bench = readNested<BenchResult>(runsRepoDir, 'bench')
  const improvements = readNested<Improvement>(runsRepoDir, 'improvements').map((i) => {
    const summary = join(runsRepoDir, 'improvements', i.id, 'summary.md')
    return { ...i, headline: existsSync(summary) ? headline(readFileSync(summary, 'utf8')) : null }
  })
  writeFileSync(file, renderReport({ generatedAt: new Date().toISOString(), rows, steps, scores, bench, improvements }))
  console.log(`report: ${rows.length} runs, ${scores.length} scores, ${bench.length} bench results, ${improvements.length} improvements -> ${file}`)
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

// A model id pi cannot resolve fails every run that uses it, and a judge that fails leaves its scores pending forever.
// pi lists a provider's models only when that provider has a key, so a placeholder key is enough and nothing is billed.
function models() {
  const ids = [...loadAgents(agentsDir), ...loadAgents(scorersDir)].map((a) => a.models.pi)
  const missing = [...new Set(ids)].filter((id) => {
    const listed = sh('docker', ['run', '--rm', '-e', 'HOME=/tmp/home', '-e', 'DEEPSEEK_API_KEY=placeholder', process.env.FACTORY_IMAGE ?? 'factory-agent', 'pi', '--list-models', id])
    return !listed.split('\n').some((row) => row.split(/\s+/).slice(0, 2).join('/') === id)
  })
  if (missing.length) throw new Error(`pi does not know these models: ${missing.join(', ')}`)
  console.log(`models: pi knows ${[...new Set(ids)].join(', ')}`)
}

const [command, ...args] = process.argv.slice(2)
const round = () => {
  if (args[0] !== '0' && args[0] !== '1') throw new Error(`${command}: round must be 0 or 1, got "${args[0]}"`)
  return Number(args[0])
}
const commands: Record<string, () => void> = {
  guard,
  preflight,
  agent: () => agent(round()),
  publish: () => publish(round()),
  review: () => review(round()),
  respond: () => respond(round()),
  record,
  'score-prepare': scorePrepare,
  'score-judge': scoreJudge,
  'score-save': scoreSave,
  'bench-run': benchRun,
  'bench-save': benchSave,
  'improve-prepare': improvePrepare,
  'improve-run': improveRun,
  'improve-save': improveSave,
  models,
  db: () => db(args[0] ?? '.'),
  report: () => report(args[0] ?? '.'),
  findings: () => process.stdout.write(findingsMarkdown(readEvidence(args[0] ?? '.'))),
  propose: () => {
    if (!args[1]) throw new Error('usage: node src/cli.ts propose <runs-dir> <improvement-id>')
    propose(args[0], args[1])
  },
}
if (!commands[command]) {
  console.error(`usage: node src/cli.ts <${Object.keys(commands).join('|')}>`)
  process.exit(2)
}
commands[command]()
