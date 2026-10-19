import type { HarnessName, Step, Transcript } from './types.ts'

type Harness = {
  // Environment variables the harness reads its API key from. Only these enter the container.
  keyEnv: string[]
  command(model: string, prompt: string): string[]
  parse(jsonl: string): Transcript
  steps(jsonl: string): Step[]
}

type Event = Record<string, any>

function events(jsonl: string): Event[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line))
}

// Tool arguments as `key: value` lines, so a reader sees the command or path, not a JSON object.
function compact(input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return JSON.stringify(input) ?? ''
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n')
}

const texts = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : ((content ?? []) as Event[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

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
    steps(jsonl) {
      return events(jsonl)
        .filter((e) => e.type === 'assistant' || e.type === 'user')
        .flatMap((e): Step[] => (e.message?.content ?? []).flatMap((c: Event): Step[] => {
          if (c.type === 'text' && e.type === 'assistant') return [{ kind: 'message', text: c.text }]
          if (c.type === 'tool_use') return [{ kind: 'tool_call', tool: c.name, input: compact(c.input) }]
          if (c.type === 'tool_result') return [{ kind: 'tool_result', output: texts(c.content), isError: c.is_error === true }]
          return []
        }))
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
    steps(jsonl) {
      return events(jsonl)
        .filter((e) => e.type === 'message_end')
        .flatMap(({ message: m }): Step[] => {
          if (m.role === 'toolResult') return [{ kind: 'tool_result', output: texts(m.content), isError: m.isError === true }]
          if (m.role !== 'assistant') return []
          return m.content.flatMap((c: Event): Step[] => {
            if (c.type === 'text') return [{ kind: 'message', text: c.text }]
            if (c.type === 'toolCall') return [{ kind: 'tool_call', tool: c.name, input: compact(c.arguments) }]
            return []
          })
        })
    },
  },
}
