import { isHarnessName, type Feedback, type HarnessName, type Issue, type IssuePlan, type RevisePlan } from './types.ts'

export const TRIGGER_LABELS = new Map<string, IssuePlan['kind']>([['factory', 'implement'], ['factory:spec', 'spec']])
export const REVISE_LABEL = 'factory:revise'
export const SPEC_MARKER = '<!-- factory:spec -->'
// Every comment the factory posts on a pull request carries it. The factory posts with the owner's token, so without
// it the factory's own reviews would read as the owner's feedback.
export const FACTORY_MARKER = '<!-- factory -->'
export const FACTORY_EMAIL = 'factory@users.noreply.github.com'
const BENCH_MARKER = /<!-- bench:([a-z0-9-]+) -->/
const FACTORY_BRANCH = /^factory\/issue-(\d+)-/

export type Decision<P> = { run: true; plan: P } | { run: false; reason: string }

type User = { login: string } | null

// The fields of a REST issue comment (`GET /repos/{repo}/issues/{n}/comments`) that the guard reads.
export type IssueComment = { user: User; body: string | null; created_at: string }
// `GET /repos/{repo}/issues/{n}`, and the `issue` of an `issues` event.
export type ApiIssue = { number: number; title: string; body: string | null; user: User; labels: { name: string }[] }
// `GET /repos/{repo}/pulls/{n}`.
export type ApiPull = {
  number: number
  html_url: string
  state: string
  user: User
  head: { ref: string; sha: string; repo: { full_name: string } | null }
}
// `GET /repos/{repo}/pulls/{n}/commits`.
export type ApiCommit = { sha: string; commit: { author: { email: string } | null; committer: { date: string } | null } }
// `GET /repos/{repo}/pulls/{n}/comments`: inline comments on the diff.
export type ReviewComment = IssueComment & { path: string; line: number | null; original_line: number | null }
// `GET /repos/{repo}/pulls/{n}/reviews`. A pending review has no submitted_at.
export type Review = { user: User; body: string | null; submitted_at: string | null }
// Everything written on a pull request: its conversation, inline comments, and review bodies.
export type Thread = { comments: IssueComment[]; reviewComments: ReviewComment[]; reviews: Review[] }

export type ReviseInputs = {
  pr: ApiPull
  issue: ApiIssue
  issueComments: IssueComment[]
  commits: ApiCommit[]
  thread: Thread
  // The merge base of the PR head with the default branch, from `GET /repos/{repo}/compare/{default}...{head}`.
  mergeBase: string
}

// Decides whether a GitHub `issues` event should start a factory run.
// Only the repo owner can start runs, and only on issues the owner wrote,
// so text from strangers never reaches an agent.
export function decide(event: any): Decision<Omit<IssuePlan, 'runId' | 'spec'>> {
  if (event.action !== 'labeled') return { run: false, reason: `action is "${event.action}", not "labeled"` }
  const kind = TRIGGER_LABELS.get(event.label?.name)
  if (!kind) return { run: false, reason: `label "${event.label?.name}" is not one of ${[...TRIGGER_LABELS.keys()].join(', ')}` }

  const owner = event.repository.owner.login
  if (event.sender.login !== owner) return { run: false, reason: `label added by ${event.sender.login}, not the owner ${owner}` }
  const from = ownerIssue(event.repository, event.issue)
  if (!from.run) return from
  return { run: true, plan: { kind, ...from.plan } }
}

// The first gate on a `pull_request` labeled event, before anything on the pull request is read. The pull request comes
// from the API, not the event. It must be an open factory branch in this repo (not a fork) that the owner opened.
// Returns the issue the branch was opened for.
export function reviseTarget(event: any, pr: ApiPull): Decision<number> {
  if (event.action !== 'labeled') return { run: false, reason: `action is "${event.action}", not "labeled"` }
  if (event.label?.name !== REVISE_LABEL) return { run: false, reason: `label "${event.label?.name}" is not ${REVISE_LABEL}` }
  const owner = event.repository.owner.login
  if (event.sender.login !== owner) return { run: false, reason: `label added by ${event.sender.login}, not the owner ${owner}` }
  if (pr.state !== 'open') return { run: false, reason: `pull request #${pr.number} is ${pr.state}` }
  if (pr.head.repo?.full_name !== event.repository.full_name) return { run: false, reason: `pull request #${pr.number} comes from a fork` }
  // A fine-grained token belongs to the repo owner, so the factory's pull requests are the owner's.
  if (pr.user?.login !== owner) return { run: false, reason: `pull request #${pr.number} opened by ${pr.user?.login}, not the owner ${owner}` }
  const issue = pr.head.ref.match(FACTORY_BRANCH)?.[1]
  if (!issue) return { run: false, reason: `branch "${pr.head.ref}" is not a factory branch` }
  return { run: true, plan: Number(issue) }
}

// Decides whether a `factory:revise` label starts a revise run, and gathers what the agent gets: the issue, the
// approved plan, and the owner's feedback since the factory's last commit.
export function decideRevise(event: any, { pr, issue, issueComments, commits, thread, mergeBase }: ReviseInputs): Decision<Omit<RevisePlan, 'runId'>> {
  const target = reviseTarget(event, pr)
  if (!target.run) return target
  const from = ownerIssue(event.repository, issue)
  if (!from.run) return from
  const since = commits
    .filter((c) => c.commit.author?.email === FACTORY_EMAIL && c.commit.committer)
    .map((c) => c.commit.committer!.date)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1)
  if (!since) return { run: false, reason: `pull request #${pr.number} has no factory commit` }
  const owner = event.repository.owner.login
  const feedback = ownerFeedback(thread, owner, since)
  if (feedback.length === 0) return { run: false, reason: `no comment by ${owner} on pull request #${pr.number} since the factory's last commit` }
  return {
    run: true,
    plan: {
      kind: 'revise',
      ...from.plan,
      spec: approvedSpec(issueComments, owner),
      pr: { number: pr.number, url: pr.html_url, branch: pr.head.ref, headSha: pr.head.sha, baseSha: mergeBase },
      feedback,
    },
  }
}

// The owner's comments, inline comments, and review bodies written after `since`, oldest first. Comments by anyone
// else never reach an agent, and neither do the factory's own comments.
export function ownerFeedback({ comments, reviewComments, reviews }: Thread, owner: string, since: string): Feedback[] {
  const after = (at: string | null): at is string => at !== null && Date.parse(at) > Date.parse(since)
  const written = (user: User, body: string | null): body is string =>
    user?.login === owner && !!body?.trim() && !body.includes(FACTORY_MARKER)
  return [
    ...comments.filter((c) => written(c.user, c.body) && after(c.created_at))
      .map((c) => ({ at: c.created_at, location: null, body: c.body!.trim() })),
    ...reviewComments.filter((c) => written(c.user, c.body) && after(c.created_at))
      .map((c) => ({ at: c.created_at, location: lineOf(c), body: c.body!.trim() })),
    ...reviews.filter((r) => written(r.user, r.body) && after(r.submitted_at))
      .map((r) => ({ at: r.submitted_at!, location: null, body: r.body!.trim() })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

// An outdated comment has no line on the current diff, so it falls back to the line it was written on.
const lineOf = (c: ReviewComment) => {
  const line = c.line ?? c.original_line
  return line === null ? c.path : `${c.path}:${line}`
}

// The issue fields a run reads, from an issue the owner wrote.
function ownerIssue(repository: any, issue: ApiIssue): Decision<{ issue: Issue; harness: HarnessName | null; task: string | null; baseBranch: string }> {
  const owner = repository.owner.login
  if (issue.user?.login !== owner) return { run: false, reason: `issue written by ${issue.user?.login}, not the owner ${owner}` }

  const harnessLabels = issue.labels
    .map((l) => l.name)
    .filter((name) => name.startsWith('harness:'))
    .map((name) => name.slice('harness:'.length))
  if (harnessLabels.length > 1) return { run: false, reason: `more than one harness label: ${harnessLabels.join(', ')}` }
  const harness = harnessLabels[0] ?? null
  if (harness !== null && !isHarnessName(harness)) return { run: false, reason: `unknown harness label "harness:${harness}"` }

  const { task, body } = splitBenchMarker(issue.body ?? '')
  return {
    run: true,
    plan: {
      harness,
      task,
      baseBranch: repository.default_branch,
      issue: { repo: repository.full_name, number: issue.number, title: issue.title, body },
    },
  }
}

// The marker is bookkeeping for scorers, so agents and judges never see it.
export function splitBenchMarker(raw: string): { task: string | null; body: string } {
  return { task: raw.match(BENCH_MARKER)?.[1] ?? null, body: raw.replace(BENCH_MARKER, '').trim() }
}

// The approved plan is the owner's latest spec comment, as the owner left it. The marker alone proves nothing,
// since anyone can write it, so comments by anyone else never become a plan.
export function approvedSpec(comments: IssueComment[], owner: string): string | null {
  const latest = comments
    .filter((c) => c.user?.login === owner && c.body?.includes(SPEC_MARKER))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1)
  return latest?.body!.replace(SPEC_MARKER, '').trim() || null
}
