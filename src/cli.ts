// Each subcommand is one step of .github/workflows/run.yml. Steps share files in FACTORY_RUN_DIR,
// and a step whose stage does not apply to this run does nothing.
//   guard           decide whether the issue event starts a run, find the approved plan   (github.token)
//   agent <round>   round 0: the spec or implement agent; round 1: implement again after a review asks for changes   (model key only)
//   publish <round> post the plan, or copy the agent's tree into a fresh clone and open or update the PR   (FACTORY_GH_TOKEN)
//   review <round>  run the review agent on the tree that round published   (model key only)
//   respond <round> post that review on the PR   (FACTORY_GH_TOKEN)
//   record          push the run record and scrubbed transcripts   (FACTORY_GH_TOKEN)
// .github/workflows/score.yml grades recorded runs:
//   score-prepare   find unscored runs and write one job dir per (run, scorer) with the evidence   (FACTORY_GH_TOKEN)
//   score-judge     run the correctness check and the judges in each job dir   (model keys only)
//   score-save      push the scores and scrubbed judge transcripts   (FACTORY_GH_TOKEN)
// .github/workflows/bench.yml replays bench tasks across harness:model configs:
//   bench-run       run the implement agent on each task x config and grade the tree   (model keys only)
//   bench-save      push the results and scrubbed transcripts   (FACTORY_GH_TOKEN)
// Local:
//   db              build runs.sqlite from a local factory-runs checkout
//   report          build report.html from a local factory-runs checkout   (your gh login)
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cellName, parseConfigs, parseTask } from './bench.ts'
import { loadAgent, loadAgents, parseScore, parseVerdict } from './agents.ts'
import { approvedSpec, decide, splitBenchMarker, SPEC_MARKER, type IssueComment } from './guard.ts'
import { credential, harnesses } from './harnesses.ts'
import { prOutcome, renderReport, type PrView, type ReportModel } from './report.ts'
import { CORRECTNESS, gradeTree, pendingScores, transcriptMarkdown } from './score.ts'
import { scrub } from './scrub.ts'
import type {
  AgentName, BenchResult, Billing, HarnessName, Issue, Plan, PublishResult, ReportRow, RunRecord, RunStatus, Score, StageResult, StageRun, Transcript,
} from './types.ts'

const SECRET_ENV = [...Object.values(harnesses).flatMap((h) => h.credentials.map((c) => c.env)), 'FACTORY_GH_TOKEN']
// Five stages at most, inside the job's 240-minute timeout.
const AGENT_TIMEOUT_MS = 40 * 60 * 1000

const factoryDir = resolve(dirname(new URL(import.meta.url).pathname), '..')
const agentsDir = join(factoryDir, 'agents')
const scorersDir = join(factoryDir, 'scorers')
const checkFile = (task: string) => join(factoryDir, 'bench', 'tasks', task, 'check.test.js')
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
type ScoreJob = { runId: string; scorer: string; task: string | null; sha: string }
const scoreJobs = () => runFile('score')

function scorePrepare() {
  const token = env('FACTORY_GH_TOKEN')
  const runsDir = cloneRunsRepo(token, env('GITHUB_REPOSITORY_OWNER'))
  const scorers = [CORRECTNESS, ...loadAgents(scorersDir).map((j) => j.name)]
  if (scorers.slice(1).includes(CORRECTNESS)) throw new Error(`scorers/${CORRECTNESS}.md: that name belongs to the built-in check`)
  const existing = subdirs(join(runsDir, 'scores')).flatMap((id) => readdirSync(join(runsDir, 'scores', id)).map((f) => `scores/${id}/${f}`))
  const pending = Map.groupBy(pendingScores(readRecords(runsDir), scorers, existing), (p) => p.run)
  console.log(`score-prepare: ${[...pending.values()].flat().length} scores pending over ${pending.size} runs`)

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

      for (const { scorer } of jobs) {
        const dir = join(scoreJobs(), `${run.id}__${scorer}`)
        if (existsSync(join(dir, 'job.json'))) continue
        rmSync(dir, { recursive: true, force: true })
        if (scorer === CORRECTNESS) {
          mkdirSync(join(dir, 'tree'), { recursive: true })
          sh('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', repo, sha, join(dir, 'tree')])
        } else {
          const evidence = join(dir, 'evidence')
          mkdirSync(evidence, { recursive: true })
          writeFileSync(join(evidence, 'issue.md'), `# ${issue.title}\n\n${splitBenchMarker(issue.body).body}\n`)
          writeFileSync(join(evidence, 'diff.patch'), git('diff', run.baseSha, sha) + '\n')
          writeFileSync(join(evidence, 'transcript.md'), transcriptMarkdown(run.stages.filter((s) => s.agent === 'implement').map((s) => {
            const file = join(runsDir, 'transcripts', run.id, `${stageName(s.agent, s.round)}.jsonl`)
            const stored = s.transcript === 'stored' && existsSync(file)
            return { name: stageName(s.agent, s.round), steps: stored ? harnesses[s.harness].steps(readFileSync(file, 'utf8')) : null }
          })))
        }
        writeJsonFile(join(dir, 'job.json'), { runId: run.id, scorer, task: run.task, sha } satisfies ScoreJob)
      }
      console.log(`score-prepare: ${run.id} ${run.repo}#${run.issueNumber} at ${sha.slice(0, 7)}: ${jobs.map((j) => j.scorer).join(', ')}`)
    } catch (e) {
      console.log(`score-prepare: warning: skipped ${run.id}: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  // These clones hold FACTORY_GH_TOKEN in their remote URL, and the next step must not see it.
  for (const dir of [runsDir, runFile('repos')]) rmSync(dir, { recursive: true, force: true })
}

function scoreJudge() {
  const judges = new Map(loadAgents(scorersDir).map((j) => [j.name, j]))
  const factorySha = sh('git', ['-C', factoryDir, 'rev-parse', 'HEAD'])
  for (const name of subdirs(scoreJobs())) {
    const dir = join(scoreJobs(), name)
    if (existsSync(join(dir, 'score.json')) || !existsSync(join(dir, 'job.json'))) continue
    const job = readJsonFile<ScoreJob>(join(dir, 'job.json'))
    const base = { runId: job.runId, scorer: job.scorer, sha: job.sha, factorySha }
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
        const pass = run.ok ? parseScore(run.transcript.finalText) : null
        const text = run.transcript.finalText.trim()
        score = {
          ...base,
          pass,
          reason: !run.ok ? 'The judge did not finish.' : text.length > 2000 ? `${text.slice(0, 2000)}…` : text || 'The judge gave no reason.',
          at: new Date().toISOString(),
          judge: { harness, model: run.transcript.model ?? def.models[harness], billing: run.billing, costUsd: run.transcript.usage.costUsd, wallTimeS: run.wallTimeS },
        }
      }
      writeJsonFile(join(dir, 'score.json'), score)
      console.log(`score-judge: ${job.runId} ${job.scorer}: ${score.pass === null ? 'unknown' : score.pass ? 'pass' : 'fail'}`)
    } catch (e) {
      console.log(`score-judge: warning: ${job.runId} ${job.scorer} not scored: ${(e as Error).message.split('\n')[0]}`)
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
    const target = join(dir, 'scores', score.runId, `${score.scorer}.json`)
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
  const implement = loadAgent(agentsDir, 'implement')
  const fixed = { benchId: env('BENCH_ID'), factoryRef: env('FACTORY_REF'), factorySha: sh('git', ['-C', factoryDir, 'rev-parse', 'HEAD']), baseSha }
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
        const grade = gradeTree(tree, checkFile(task), sandbox(tree))
        const result: Omit<BenchResult, 'transcript'> = {
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
    const result = readJsonFile<Omit<BenchResult, 'transcript'>>(join(benchCells(), file))
    const target = join(dir, 'bench', result.benchId, file)
    if (existsSync(target)) continue
    mkdirSync(dirname(target), { recursive: true })
    const raw = join(benchCells(), file.replace(/\.json$/, '.jsonl'))
    const transcript = existsSync(raw) ? storable(readFileSync(raw, 'utf8')) : null
    if (transcript) writeFileSync(target.replace(/\.json$/, '.jsonl'), transcript)
    writeJsonFile(target, { ...result, transcript: transcript ? 'stored' : 'withheld' } satisfies BenchResult)
    saved++
  }
  if (!pushRunsRepo(dir, `bench: ${saved} results`)) return console.log('bench-save: nothing new to save')
  console.log(`bench-save: pushed ${saved} results`)
}

function readRecords(runsRepoDir: string): RunRecord[] {
  return readdirSync(join(runsRepoDir, 'runs'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(runsRepoDir, 'runs', f), 'utf8')))
}

// Files under <runs repo>/<kind>/<id>/*.json, such as scores/<runId>/<scorer>.json. A missing dir has none.
function readNested<T>(runsRepoDir: string, kind: 'scores' | 'bench'): T[] {
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
    run_id TEXT REFERENCES runs(id), scorer TEXT, pass INTEGER, reason TEXT, sha TEXT, factory_sha TEXT, at TEXT,
    judge_harness TEXT, judge_model TEXT, judge_billing TEXT, judge_cost_usd REAL, judge_wall_time_s INTEGER, PRIMARY KEY (run_id, scorer))`)
  database.exec(`CREATE TABLE bench (
    bench_id TEXT, task TEXT, harness TEXT, requested_model TEXT, model TEXT, factory_ref TEXT, factory_sha TEXT, base_sha TEXT,
    billing TEXT, pass INTEGER, check_output TEXT, input_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER,
    cost_usd REAL, wall_time_s INTEGER, at TEXT, transcript TEXT, PRIMARY KEY (bench_id, task, harness, requested_model))`)
  const insertRun = database.prepare(`INSERT INTO runs VALUES (${Array(21).fill('?').join(', ')})`)
  const insertStage = database.prepare(`INSERT INTO stages VALUES (${Array(15).fill('?').join(', ')})`)
  const insertScore = database.prepare(`INSERT INTO scores VALUES (${Array(12).fill('?').join(', ')})`)
  const insertBench = database.prepare(`INSERT INTO bench VALUES (${Array(18).fill('?').join(', ')})`)
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
  const scores = readNested<Score>(runsRepoDir, 'scores')
  for (const s of scores) {
    insertScore.run(s.runId, s.scorer, bool(s.pass), s.reason, s.sha, s.factorySha, s.at,
      s.judge?.harness ?? null, s.judge?.model ?? null, s.judge?.billing ?? null, s.judge?.costUsd ?? null, s.judge?.wallTimeS ?? null)
  }
  const bench = readNested<BenchResult>(runsRepoDir, 'bench')
  for (const b of bench) {
    insertBench.run(b.benchId, b.task, b.harness, b.requestedModel, b.model, b.factoryRef, b.factorySha, b.baseSha, b.billing, bool(b.pass),
      b.checkOutput, b.usage.inputTokens, b.usage.cacheReadTokens, b.usage.outputTokens, b.costUsd, b.wallTimeS, b.at, b.transcript)
  }
  database.close()
  console.log(`db: ${records.length} runs, ${scores.length} scores, ${bench.length} bench results -> ${file}`)
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
  const scores = readNested<Score>(runsRepoDir, 'scores')
  const bench = readNested<BenchResult>(runsRepoDir, 'bench')
  writeFileSync(file, renderReport({ generatedAt: new Date().toISOString(), rows, steps, scores, bench }))
  console.log(`report: ${rows.length} runs, ${scores.length} scores, ${bench.length} bench results -> ${file}`)
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
  'score-prepare': scorePrepare,
  'score-judge': scoreJudge,
  'score-save': scoreSave,
  'bench-run': benchRun,
  'bench-save': benchSave,
  db: () => db(args[0] ?? '.'),
  report: () => report(args[0] ?? '.'),
}
if (!commands[command]) {
  console.error(`usage: node src/cli.ts <${Object.keys(commands).join('|')}>`)
  process.exit(2)
}
commands[command]()
