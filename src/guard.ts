import { isHarnessName, type Plan } from './types.ts'

export const TRIGGER_LABEL = 'factory'

export type Decision = { run: true; plan: Omit<Plan, 'runId'> } | { run: false; reason: string }

// Decides whether a GitHub `issues` event should start a factory run.
// Only the repo owner can start runs, and only on issues the owner wrote,
// so text from strangers never reaches an agent.
export function decide(event: any): Decision {
  if (event.action !== 'labeled') return { run: false, reason: `action is "${event.action}", not "labeled"` }
  if (event.label?.name !== TRIGGER_LABEL) return { run: false, reason: `label "${event.label?.name}" is not "${TRIGGER_LABEL}"` }

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

  return {
    run: true,
    plan: {
      harness,
      baseBranch: event.repository.default_branch,
      issue: {
        repo: event.repository.full_name,
        number: event.issue.number,
        title: event.issue.title,
        body: event.issue.body ?? '',
      },
    },
  }
}
