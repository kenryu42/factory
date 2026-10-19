// Runs the real QA step in the factory image: `docker build -t factory-agent docker`, then FACTORY_QA_IT=1 pnpm test.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { QaResult } from '../src/types.ts'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const page = (body: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;font:16px sans-serif}</style></head><body>${body}</body></html>`
const serve = `import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  try {
    const body = await readFile('dist' + (path.endsWith('/') ? path + 'index.html' : path))
    res.writeHead(200, { 'content-type': path.endsWith('.png') ? 'image/png' : 'text/html' }).end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(Number(process.argv[2]), '127.0.0.1')
`
const qaConfig = (pages: string[]) => JSON.stringify({
  build: 'rm -rf dist && cp -r site dist',
  serve: 'node serve.mjs 4321',
  url: 'http://localhost:4321',
  pages,
  widths: [360, 1280],
  schemes: ['light', 'dark'],
})

test('the QA step finds the page that scrolls sideways, even when the change drops it from qa.json', { skip: process.env.FACTORY_QA_IT !== '1' && 'set FACTORY_QA_IT=1 to run the browser in the factory image' }, () => {
  const run = mkdtempSync(join(tmpdir(), 'qa-it-'))
  const pub = join(run, 'pub')
  const write = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(pub, file, '..'), { recursive: true })
      writeFileSync(join(pub, file), text)
    }
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', pub, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  const commit = () => {
    git('add', '-A')
    git('commit', '--quiet', '-m', 'c')
    return git('rev-parse', 'HEAD')
  }
  mkdirSync(pub)
  git('init', '--quiet')
  write({
    '.factory/qa.json': qaConfig(['/', '/news/']),
    'serve.mjs': serve,
    'site/index.html': page('<h1>Home</h1><p>Fits any screen.</p>'),
    'site/news/index.html': page('<h1>News</h1>'),
  })
  const baseSha = commit()
  write({
    '.factory/qa.json': qaConfig(['/']),
    'site/news/index.html': page('<h1>News</h1><div class="banner wide" style="width:600px">Breaking: a banner wider than a phone</div><img src="/missing.png" alt="">'),
  })
  const sha = commit()

  writeFileSync(join(run, 'plan.json'), JSON.stringify({ kind: 'implement', runId: 'it', issue: { repo: 'o/r', number: 1, title: 't', body: 'b' } }))
  writeFileSync(join(run, 'implement-0.json'), JSON.stringify({ baseSha }))
  writeFileSync(join(run, 'publish-0.json'), JSON.stringify({ status: 'pr_opened', branch: 'b', prUrl: 'u', sha }))

  const r = spawnSync('node', [cli, 'qa', '0'], { encoding: 'utf8', env: { ...process.env, FACTORY_RUN_DIR: run } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /qa 0: failed: 8 checks of 2 pages, 2 overflow, 4 console errors, 4 failed requests, 0 did not load/)

  const result: QaResult = JSON.parse(readFileSync(join(run, 'qa-0', 'qa.json'), 'utf8'))
  assert.equal(result.setupError, null)
  const check = (p: string, width: number, scheme: string) => result.checks.find((c) => c.page === p && c.width === width && c.scheme === scheme)!
  for (const scheme of ['light', 'dark']) {
    const narrow = check('/news/', 360, scheme)
    assert.equal(narrow.overflowPx, 240)
    assert.deepEqual(narrow.offenders, [{ element: 'div.banner.wide', text: 'Breaking: a banner wider than a phone', right: 600 }])
    assert.deepEqual(narrow.failedRequests, [{ url: 'http://localhost:4321/missing.png', status: 404 }])
    assert.equal(check('/news/', 1280, scheme).overflowPx, 0)
    assert.equal(check('/', 360, scheme).overflowPx, 0)
    assert.deepEqual(check('/', 360, scheme).consoleErrors, [])
  }
  for (const c of result.checks) assert.ok(existsSync(join(run, 'qa-0', 'screenshots', c.screenshot!)), c.screenshot!)
  assert.equal(readFileSync(join(run, 'qa-0', 'screenshots', 'news-360-dark.png')).subarray(1, 4).toString(), 'PNG')
})
