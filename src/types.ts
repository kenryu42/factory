export const HARNESS_NAMES = ['claude-code', 'pi'] as const
export type HarnessName = (typeof HARNESS_NAMES)[number]

export function isHarnessName(value: string): value is HarnessName {
  return (HARNESS_NAMES as readonly string[]).includes(value)
}

export type AgentName = 'spec' | 'implement' | 'review'

export type Agent = {
  name: string
  defaultHarness: HarnessName
  models: Record<HarnessName, string>
  prompt: string
}

export type Issue = {
  repo: string
  number: number
  title: string
  body: string
}

// On an issue, a `factory:spec` label asks for a plan and a `factory` label for a pull request.
// On a factory pull request, a `factory:revise` label asks for one more commit that addresses the owner's comments.
export type RunKind = 'spec' | 'implement' | 'revise'

// The factory pull request a revise run pushes to.
export type PullRequest = {
  number: number
  url: string
  branch: string
  // The branch head the run starts from. The push only fast-forwards it, so a commit pushed meanwhile is never lost.
  headSha: string
  // The merge base with the default branch, so the diff and the record cover the whole pull request.
  baseSha: string
}

// One comment the owner left on a pull request. location is `path:line` for an inline review comment.
export type Feedback = { at: string; location: string | null; body: string }

type PlanBase = {
  runId: string
  issue: Issue
  baseBranch: string
  // From a harness:<name> label on the issue. It picks the implement harness only. null means the agent's default.
  harness: HarnessName | null
  // The plan in the owner's latest spec comment on the issue, which the owner may have edited.
  spec: string | null
  // Benchmark task id from a `<!-- bench:<id> -->` marker in the issue body.
  task: string | null
}
export type IssuePlan = PlanBase & { kind: 'spec' | 'implement' }
export type RevisePlan = PlanBase & { kind: 'revise'; pr: PullRequest; feedback: Feedback[] }
export type Plan = IssuePlan | RevisePlan

export type Usage = {
  // Input tokens not served from cache, including tokens written to cache.
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  // null when the run reported no price, such as a run that ended before its final event.
  costUsd: number | null
}

export type Transcript = {
  ok: boolean
  finalText: string
  // The exact model that answered, as the harness reports it. Aliases like `sonnet` drift over time.
  model: string | null
  usage: Usage
}

export type Billing = 'subscription' | 'api'

export type Verdict = 'approve' | 'request_changes'

// One agent invocation. Round 0 is the first pass, which in a revise run is the revision the owner asked for.
// Round 1 is the revise round after a review asks for changes.
export type StageRun = {
  agent: AgentName
  round: number
  harness: HarnessName
  model: string
  billing: Billing
  ok: boolean
  // Review stages only. null when the review ended without a readable verdict.
  verdict: Verdict | null
  usage: Usage
  startedAt: string
  wallTimeS: number
  transcript: 'stored' | 'withheld'
}

// What a stage leaves in FACTORY_RUN_DIR for the steps after it.
export type StageResult = Omit<StageRun, 'transcript'> & { finalText: string; baseSha: string }

export type RunStatus =
  | 'pr_opened' | 'pr_updated' | 'spec_posted' | 'no_changes' | 'agent_failed' | 'publish_failed' | 'blocked_secret' | 'blocked_workflow_change'

export type PublishResult = {
  status: RunStatus
  branch: string | null
  prUrl: string | null
  // The commit this round pushed to the PR branch. null when it pushed nothing.
  sha: string | null
}

export const COLOR_SCHEMES = ['light', 'dark'] as const
export type ColorScheme = (typeof COLOR_SCHEMES)[number]

// A target repo's .factory/qa.json, read from the base commit so the agent cannot weaken its own QA.
export type QaConfig = {
  // Shell commands run in the published tree: build to completion, then serve in the background.
  build: string
  serve: string
  // Where serve listens. Each page is a path (with an optional query) under it.
  url: string
  pages: string[]
  widths: number[]
  schemes: ColorScheme[]
}

// An element whose right edge passes the viewport's: `tag.class` plus the start of its text.
export type QaOffender = { element: string; text: string; right: number }

// One page loaded at one width and color scheme.
export type QaCheck = {
  page: string
  width: number
  scheme: ColorScheme
  // Why the page did not load, such as a timeout or a 404 response. null when it loaded.
  loadError: string | null
  // How far the document scrolls sideways past the viewport, in CSS pixels. 0 when it fits.
  overflowPx: number
  offenders: QaOffender[]
  consoleErrors: string[]
  // Same-origin responses with a 4xx or 5xx status.
  failedRequests: { url: string; status: number }[]
  // The full-page JPEG, relative to the screenshots directory.
  screenshot: string | null
}

// What the QA browser writes to qa.json. setupError means the build failed or the server never answered.
export type QaResult = { url: string; setupError: string | null; checks: QaCheck[] }

// One round's QA in the run record. The published tree's checks are compared with the same checks on the base
// commit: only new failures fail the QA, fixed ones were failing on the base, and still failing ones fail on both.
export type QaSummary = {
  round: number
  failed: boolean
  // Why the published tree could not be checked, or why the base could not be, which leaves no failure to compare with.
  setupError: string | null
  baseSetupError: string | null
  pages: number
  checks: number
  newFailures: number
  fixed: number
  stillFailing: number
}

export type RunRecord = {
  id: string
  startedAt: string
  trigger: string
  factorySha: string
  kind: RunKind
  task: string | null
  issueNumber: number
  // The harness and model of the run's main agent: implement, or spec for a spec run.
  harness: HarnessName
  model: string
  repo: string
  baseSha: string
  branch: string | null
  prUrl: string | null
  status: RunStatus
  // The last review's verdict.
  verdict: Verdict | null
  stages: StageRun[]
  // One entry per round the visual QA ran in. Empty when the repo has no .factory/qa.json, and missing on older runs.
  qa?: QaSummary[]
  // Totals over stages. costUsd is null only when no stage reported a price.
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  costUsd: number | null
  wallTimeS: number
  runUrl: string
}

// One readable entry of a transcript, as the report shows it.
export type Step =
  | { kind: 'message'; text: string }
  | { kind: 'tool_call'; tool: string; input: string }
  | { kind: 'tool_result'; output: string; isError: boolean }

export type Outcome = 'open' | 'merged' | 'closed' | 'reverted'

export type ReportRow = RunRecord & {
  // null when unknown: the run opened no PR, or the GitHub lookup failed.
  outcome: Outcome | null
  humanTouches: number | null
}

// What a score grades: an implement run's final pushed tree, or one bench cell's change.
export type ScoreSubject = { kind: 'run'; runId: string } | { kind: 'bench'; benchId: string; cell: string }

// One file per (subject, scorer): scores/<runId>/<scorer>.json, or scores/bench/<benchId>/<cell>/<scorer>.json.
export type Score = {
  subject: ScoreSubject
  // `correctness`, or the name of a judge file in scorers/.
  scorer: string
  // null when the run could not be scored; reason says why.
  pass: boolean | null
  reason: string
  // A run's graded commit: the last commit the factory pushed to the PR. A bench cell's base commit, which its stored diff applies to.
  sha: string
  factorySha: string
  at: string
  // null for deterministic scorers.
  judge: { harness: HarnessName; model: string; billing: Billing; costUsd: number | null; wallTimeS: number } | null
  // The hidden check files a correctness score was graded with, so its output can be summarized without quoting them.
  // Absent from judge scores and from scores saved before it was recorded.
  check?: string[]
}

// One harness and model to benchmark, written `harness:model`.
export type BenchConfig = { harness: HarnessName; model: string }

// One cell of a benchmark: one task under one config.
// Stored at bench/<benchId>/<task>__<harness>__<requested model, / as _>.json, next to its .jsonl transcript and .patch diff.
export type BenchResult = {
  benchId: string
  // owner/name of the repo that holds the task. Absent from cells saved before it was recorded.
  repo?: string
  task: string
  // The task's hidden check files. Absent from cells saved before it was recorded.
  check?: string[]
  harness: HarnessName
  requestedModel: string
  // The exact model, as the harness reports it.
  model: string
  // The ref the bench was asked for, and the commit it resolved to.
  factoryRef: string
  factorySha: string
  baseSha: string
  billing: Billing
  // null when the task has no check.
  pass: boolean | null
  // The tail of the check's output.
  checkOutput: string
  usage: Usage
  costUsd: number | null
  wallTimeS: number
  at: string
  transcript: 'stored' | 'withheld'
  // The agent's change against baseSha, without the hidden check. withheld when it was not stored: gitleaks flagged it,
  // or the cell predates stored diffs.
  diff: 'stored' | 'withheld'
}

export type ImprovementStatus = 'proposed' | 'no_change' | 'agent_failed' | 'blocked_secret' | 'blocked_scope'

// One run of the improve agent over the evidence in factory-runs. Stored at improvements/<id>/improvement.json,
// next to findings.md (the evidence it read) and, when it may be stored, patch.diff, summary.md and improve.jsonl.
export type Improvement = {
  id: string
  at: string
  // The factory commit the agent read and the patch applies to.
  factorySha: string
  basis: { runs: number; scores: number; failingScores: number; benches: string[] }
  harness: HarnessName
  model: string
  costUsd: number | null
  wallTimeS: number
  changedFiles: string[]
  status: ImprovementStatus
}
