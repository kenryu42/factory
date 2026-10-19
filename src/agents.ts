import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { HARNESS_NAMES, isHarnessName, type Agent, type Verdict } from './types.ts'

// Agent files (agents/*.md) and judge files (scorers/*.md) are markdown with flat `key: value` frontmatter:
//   harness: <default harness>
//   claude-code: <model>   pi: <model>
export function parseAgent(name: string, text: string): Agent {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) throw new Error(`${name}.md: missing --- frontmatter ---`)
  const fields = new Map<string, string>()
  for (const raw of match[1].split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 1) throw new Error(`${name}.md: bad frontmatter line "${raw}"`)
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }

  const defaultHarness = fields.get('harness') ?? ''
  if (!isHarnessName(defaultHarness)) {
    throw new Error(`${name}.md: harness must be one of ${HARNESS_NAMES.join(', ')}, got "${defaultHarness}"`)
  }
  const models = Object.fromEntries(
    HARNESS_NAMES.map((h) => {
      const model = fields.get(h)
      if (!model) throw new Error(`${name}.md: missing model for ${h}`)
      return [h, model]
    }),
  ) as Agent['models']

  const prompt = match[2].trim()
  if (!prompt) throw new Error(`${name}.md: prompt is empty`)
  return { name, defaultHarness, models, prompt }
}

export function loadAgent(dir: string, name: string): Agent {
  return parseAgent(name, readFileSync(join(dir, `${name}.md`), 'utf8'))
}

// Every agent file in a directory, such as scorers/, by name.
export function loadAgents(dir: string): Agent[] {
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => loadAgent(dir, basename(f, '.md')))
}

// The value of the last `<KEY>: value` line. Only the last one counts, so a line quoted earlier never decides.
// Markdown emphasis around the line is tolerated.
function lastTagged(text: string, key: string): string | undefined {
  const line = text
    .split('\n')
    .map((l) => l.trim().replace(/^[*`]+|[*`]+$/g, '').trim())
    .findLast((l) => l.startsWith(`${key}:`))
  return line?.slice(key.length + 1).trim()
}

// The review agent ends with `VERDICT: approve` or `VERDICT: request_changes`.
export function parseVerdict(text: string): Verdict | null {
  const value = lastTagged(text, 'VERDICT')
  return value === 'approve' || value === 'request_changes' ? value : null
}

// A judge ends with `SCORE: pass` or `SCORE: fail`. null means the judge gave no readable score.
export function parseScore(text: string): boolean | null {
  const value = lastTagged(text, 'SCORE')
  return value === 'pass' ? true : value === 'fail' ? false : null
}
