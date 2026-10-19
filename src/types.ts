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

// A `factory:spec` label asks for a plan, a `factory` label for a pull request.
export type RunKind = 'spec' | 'implement'

export type Plan = {
  runId: string
  kind: RunKind
  issue: Issue
  baseBranch: string
  // From a harness:<name> label. It picks the implement harness only. null means the agent's default.
  harness: HarnessName | null
  // The plan in the owner's latest spec comment on the issue, which the owner may have edited.
  spec: string | null
  // Benchmark task id from a `<!-- bench:<id> -->` marker in the issue body.
  task: string | null
}

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

// One agent invocation. Round 0 is the first pass; round 1 is the revise round after a review asks for changes.
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
  | 'pr_opened' | 'spec_posted' | 'no_changes' | 'agent_failed' | 'publish_failed' | 'blocked_secret' | 'blocked_workflow_change'

export type PublishResult = {
  status: RunStatus
  branch: string | null
  prUrl: string | null
  // The commit this round pushed to the PR branch. null when it pushed nothing.
  sha: string | null
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

// A grade of one implement run's final pushed tree. One file per (run, scorer): scores/<runId>/<scorer>.json.
export type Score = {
  runId: string
  // `correctness`, or the name of a judge file in scorers/.
  scorer: string
  // null when the run could not be scored; reason says why.
  pass: boolean | null
  reason: string
  // The commit that was graded: the last commit the factory pushed to the PR.
  sha: string
  factorySha: string
  at: string
  // null for deterministic scorers.
  judge: { harness: HarnessName; model: string; billing: Billing; costUsd: number | null; wallTimeS: number } | null
}

// One harness and model to benchmark, written `harness:model`.
export type BenchConfig = { harness: HarnessName; model: string }

// One cell of a benchmark: one task under one config.
// Stored at bench/<benchId>/<task>__<harness>__<requested model, / as _>.json.
export type BenchResult = {
  benchId: string
  task: string
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
