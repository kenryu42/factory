import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HARNESS_NAMES, isHarnessName, type Agent, type AgentName, type Verdict } from './types.ts'

// Agent files are markdown with flat `key: value` frontmatter:
//   harness: <default harness>
//   claude-code: <model>   pi: <model>
export function parseAgent(name: AgentName, text: string): Agent {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) throw new Error(`agents/${name}.md: missing --- frontmatter ---`)
  const fields = new Map<string, string>()
  for (const raw of match[1].split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 1) throw new Error(`agents/${name}.md: bad frontmatter line "${raw}"`)
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }

  const defaultHarness = fields.get('harness') ?? ''
  if (!isHarnessName(defaultHarness)) {
    throw new Error(`agents/${name}.md: harness must be one of ${HARNESS_NAMES.join(', ')}, got "${defaultHarness}"`)
  }
  const models = Object.fromEntries(
    HARNESS_NAMES.map((h) => {
      const model = fields.get(h)
      if (!model) throw new Error(`agents/${name}.md: missing model for ${h}`)
      return [h, model]
    }),
  ) as Agent['models']

  const prompt = match[2].trim()
  if (!prompt) throw new Error(`agents/${name}.md: prompt is empty`)
  return { name, defaultHarness, models, prompt }
}

export function loadAgent(factoryDir: string, name: AgentName): Agent {
  return parseAgent(name, readFileSync(join(factoryDir, 'agents', `${name}.md`), 'utf8'))
}

// The review agent ends with `VERDICT: approve` or `VERDICT: request_changes`. The last VERDICT line decides,
// so a verdict quoted earlier in the review never counts. Markdown emphasis around the line is tolerated.
export function parseVerdict(text: string): Verdict | null {
  const line = text
    .split('\n')
    .map((l) => l.trim().replace(/^[*`]+|[*`]+$/g, '').trim())
    .findLast((l) => l.startsWith('VERDICT:'))
  const value = line?.slice('VERDICT:'.length).trim()
  return value === 'approve' || value === 'request_changes' ? value : null
}
