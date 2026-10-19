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
    steps(jsonl) {
      return events(jsonl)
        .filter((e) => e.type === 'item.completed')
        .flatMap(({ item }): Step[] => {
          if (item.type === 'agent_message') return [{ kind: 'message', text: item.text }]
          if (item.type === 'command_execution') return [
            { kind: 'tool_call', tool: 'shell', input: item.command },
            { kind: 'tool_result', output: item.aggregated_output ?? '', isError: item.exit_code !== 0 },
          ]
          if (item.type === 'file_change') {
            return [{ kind: 'tool_call', tool: 'file_change', input: item.changes.map((c: Event) => `${c.kind} ${c.path}`).join('\n') }]
          }
          return []
        })
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
