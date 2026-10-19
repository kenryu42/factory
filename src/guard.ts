import { isHarnessName, type Plan, type RunKind } from './types.ts'

export const TRIGGER_LABELS = new Map<string, RunKind>([['factory', 'implement'], ['factory:spec', 'spec']])
export const SPEC_MARKER = '<!-- factory:spec -->'
const BENCH_MARKER = /<!-- bench:([a-z0-9-]+) -->/

export type Decision = { run: true; plan: Omit<Plan, 'runId' | 'spec'> } | { run: false; reason: string }

// The fields of a REST issue comment (`GET /repos/{repo}/issues/{n}/comments`) that the guard reads.
export type IssueComment = { user: { login: string } | null; body: string | null; created_at: string }

// Decides whether a GitHub `issues` event should start a factory run.
// Only the repo owner can start runs, and only on issues the owner wrote,
// so text from strangers never reaches an agent.
export function decide(event: any): Decision {
  if (event.action !== 'labeled') return { run: false, reason: `action is "${event.action}", not "labeled"` }
  const kind = TRIGGER_LABELS.get(event.label?.name)
  if (!kind) return { run: false, reason: `label "${event.label?.name}" is not one of ${[...TRIGGER_LABELS.keys()].join(', ')}` }

  const owner = event.repository.owner.login
  if (event.sender.login !== owner) return { run: false, reason: `label added by ${event.sender.login}, not the owner ${owner}` }
  if (event.issue.user.login !== owner) return { run: false, reason: `issue written by ${event.issue.user.login}, not the owner ${owner}` }

  const harnessLabels: string[] = event.issue.labels
    .map((l: { name: string }) => l.name)
    .filter((name: string) => name.startsWith('harness:'))
    .map((name: string) => name.slice('harness:'.length))
  if (harnessLabels.length > 1) return { run: false, reason: `more than one harness label: ${harnessLabels.join(', ')}` }
  const harness = harnessLabels[0] ?? null
  if (harness !== null && !isHarnessName(harness)) return { run: false, reason: `unknown harness label "harness:${harness}"` }

  const { task, body } = splitBenchMarker(event.issue.body ?? '')
  return {
    run: true,
    plan: {
      kind,
      harness,
      task,
      baseBranch: event.repository.default_branch,
      issue: {
        repo: event.repository.full_name,
        number: event.issue.number,
        title: event.issue.title,
        body,
      },
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
