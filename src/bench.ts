import { HARNESS_NAMES, isHarnessName, type BenchConfig } from './types.ts'

// `harness:model` pairs separated by commas, such as `claude-code:haiku,pi:deepseek/deepseek-v4-flash`.
export function parseConfigs(text: string): BenchConfig[] {
  const configs = text.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const colon = entry.indexOf(':')
    const harness = colon < 0 ? entry : entry.slice(0, colon).trim()
    const model = colon < 0 ? '' : entry.slice(colon + 1).trim()
    if (!isHarnessName(harness)) throw new Error(`bench config "${entry}": harness must be one of ${HARNESS_NAMES.join(', ')}`)
    if (!model) throw new Error(`bench config "${entry}": no model; write it as ${harness}:<model>`)
    return { harness, model }
  })
  if (configs.length === 0) throw new Error('no bench configs given')
  return configs
}

// A bench task.md is the issue: a `# Title` line, then the body.
export function parseTask(text: string): { title: string; body: string } {
  const [first, ...rest] = text.split('\n')
  const title = first.replace(/^#\s*/, '').trim()
  if (!first.startsWith('#') || !title) throw new Error('task.md must start with a "# Title" line')
  return { title, body: rest.join('\n').trim() }
}

// The file name of one cell's result, without extension.
export const cellName = (task: string, c: BenchConfig) => `${task}__${c.harness}__${c.model.replaceAll('/', '_')}`
