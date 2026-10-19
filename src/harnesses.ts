import type { HarnessName, Transcript } from './types.ts'

type Harness = {
  // Environment variables the harness reads its API key from. Only these enter the container.
  keyEnv: string[]
  command(model: string, prompt: string): string[]
  parse(jsonl: string): Transcript
}

type Event = Record<string, any>

function events(jsonl: string): Event[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line))
}

const failed: Transcript = {
  ok: false,
  finalText: '',
  usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: null },
}

export const harnesses: Record<HarnessName, Harness> = {
  'claude-code': {
    keyEnv: ['ANTHROPIC_API_KEY'],
    command: (model, prompt) => [
      'claude', '-p', prompt,
      '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      '--model', model,
    ],
    parse(jsonl) {
      const result = events(jsonl).findLast((e) => e.type === 'result')
      if (!result) return failed
      const u = result.usage ?? {}
      return {
        ok: result.subtype === 'success' && !result.is_error,
        finalText: result.result ?? '',
        usage: {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          costUsd: result.total_cost_usd ?? null,
        },
      }
    },
  },

  codex: {
    keyEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    command: (model, prompt) => [
      'codex', 'exec', '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-m', model,
      prompt,
    ],
    parse(jsonl) {
      const all = events(jsonl)
      const turns = all.filter((e) => e.type === 'turn.completed')
      if (turns.length === 0) return failed
      const sum = (key: string) => turns.reduce((n, t) => n + (t.usage?.[key] ?? 0), 0)
      const lastMessage = all.findLast((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
      return {
        ok: !all.some((e) => e.type === 'turn.failed' || e.type === 'error'),
        finalText: lastMessage?.item.text ?? '',
        usage: {
          inputTokens: sum('input_tokens') - sum('cached_input_tokens'),
          cacheReadTokens: sum('cached_input_tokens'),
          outputTokens: sum('output_tokens'),
          costUsd: null,
        },
      }
    },
  },

  pi: {
    keyEnv: ['DEEPSEEK_API_KEY'],
    command: (model, prompt) => ['pi', '-p', '--mode', 'json', '--no-session', '--model', model, '--', prompt],
    parse(jsonl) {
      const end = events(jsonl).findLast((e) => e.type === 'agent_end')
      if (!end) return failed
      const replies: Event[] = end.messages.filter((m: Event) => m.role === 'assistant')
      const last = replies.at(-1)
      const sum = (pick: (u: Event) => number) => replies.reduce((n, m) => n + (m.usage ? pick(m.usage) : 0), 0)
      return {
        ok: last?.stopReason === 'stop',
        finalText: (last?.content ?? [])
          .filter((c: Event) => c.type === 'text')
          .map((c: Event) => c.text)
          .join('\n'),
        usage: {
          inputTokens: sum((u) => u.input + u.cacheWrite),
          cacheReadTokens: sum((u) => u.cacheRead),
          outputTokens: sum((u) => u.output),
          costUsd: sum((u) => u.cost.total),
        },
      }
    },
  },
}
