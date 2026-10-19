export const HARNESS_NAMES = ['claude-code', 'pi'] as const
export type HarnessName = (typeof HARNESS_NAMES)[number]

export function isHarnessName(value: string): value is HarnessName {
  return (HARNESS_NAMES as readonly string[]).includes(value)
}

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

export type Plan = {
  runId: string
  issue: Issue
  baseBranch: string
  // From a harness:<name> label. null means the agent's default.
  harness: HarnessName | null
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
  usage: Usage
}

export type AgentResult = Transcript & {
  agent: string
  harness: HarnessName
  model: string
  baseSha: string
  startedAt: string
  wallTimeS: number
}

export type RunStatus = 'pr_opened' | 'no_changes' | 'agent_failed' | 'publish_failed' | 'blocked_secret' | 'blocked_workflow_change'

export type PublishResult = {
  status: RunStatus
  branch: string | null
  prUrl: string | null
}

export type RunRecord = {
  id: string
  startedAt: string
  trigger: string
  factorySha: string
  agent: string
  harness: HarnessName
  model: string
  repo: string
  baseSha: string
  branch: string | null
  prUrl: string | null
  status: RunStatus
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  costUsd: number | null
  wallTimeS: number
  transcript: 'stored' | 'withheld'
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
