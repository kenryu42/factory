// The visual QA, run with node inside the factory image as /opt/qa/qa.mjs (see docker/Dockerfile).
// It builds and serves the tree in /work per /out/config.json (a QaConfig), loads every page at every width and
// color scheme in headless Chromium, and writes /out/qa.json (a QaResult) and /out/screenshots/*.png.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const OUT = '/out'
const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const SERVE_TIMEOUT_MS = 60 * 1000
const PAGE_TIMEOUT_MS = 30 * 1000

const config = JSON.parse(readFileSync(`${OUT}/config.json`, 'utf8'))
const tail = (file) => readFileSync(file, 'utf8').trim().split('\n').slice(-15).join('\n')
const finish = (setupError, checks) => {
  writeFileSync(`${OUT}/qa.json`, JSON.stringify({ url: config.url, setupError, checks }, null, 2) + '\n')
  console.log(`qa: ${setupError ?? `${checks.length} checks`}`)
  process.exit(0)
}

const buildLog = openSync(`${OUT}/build.log`, 'w')
const built = spawnSync('sh', ['-c', config.build], { cwd: '/work', stdio: ['ignore', buildLog, buildLog], timeout: BUILD_TIMEOUT_MS })
closeSync(buildLog)
if (built.status !== 0) finish(`build exited with ${built.status ?? built.signal}:\n${tail(`${OUT}/build.log`)}`, [])

const serveLog = openSync(`${OUT}/serve.log`, 'w')
const server = spawn('sh', ['-c', config.serve], { cwd: '/work', stdio: ['ignore', serveLog, serveLog] })
let exited = null
server.on('exit', (code, signal) => (exited = code ?? signal))
const deadline = Date.now() + SERVE_TIMEOUT_MS
for (;;) {
  if (exited !== null) finish(`serve exited with ${exited} before answering:\n${tail(`${OUT}/serve.log`)}`, [])
  if (Date.now() > deadline) finish(`serve did not answer at ${config.url} within ${SERVE_TIMEOUT_MS / 1000}s:\n${tail(`${OUT}/serve.log`)}`, [])
  const up = await fetch(config.url).then(() => true, () => false)
  if (up) break
  await new Promise((r) => setTimeout(r, 500))
}

// Runs in the page. Elements whose right edge passes the viewport, outermost containers and clipped content left out.
function measure() {
  const root = document.documentElement
  const width = root.clientWidth
  const overflowPx = Math.max(0, root.scrollWidth - width)
  if (!overflowPx) return { overflowPx, offenders: [] }
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== root; p = p.parentElement) {
      if (getComputedStyle(p).overflowX !== 'visible' && p.getBoundingClientRect().right <= width + 0.5) return true
    }
    return false
  }
  const out = [...document.body.querySelectorAll('*')].filter((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.right > width + 0.5 && !clipped(el)
  })
  const leaves = out.filter((el) => !out.some((o) => o !== el && el.contains(o)))
  leaves.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
  return {
    overflowPx,
    offenders: leaves.slice(0, 3).map((el) => ({
      element: [el.tagName.toLowerCase(), ...[...el.classList].slice(0, 3)].join('.'),
      text: (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      right: Math.round(el.getBoundingClientRect().right),
    })),
  }
}

const origin = new URL(config.url).origin
const slug = (page) => page.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-') || 'index'
mkdirSync(`${OUT}/screenshots`, { recursive: true })
const browser = await chromium.launch()
const checks = []
for (const page of config.pages) {
  for (const width of config.widths) {
    for (const scheme of config.schemes) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: scheme, reducedMotion: 'reduce' })
      const tab = await context.newPage()
      const consoleErrors = []
      const failedRequests = []
      tab.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
      tab.on('pageerror', (e) => consoleErrors.push(String(e.message ?? e)))
      tab.on('response', (r) => r.status() >= 400 && new URL(r.url()).origin === origin && failedRequests.push({ url: r.url(), status: r.status() }))
      const check = { page, width, scheme, loadError: null, overflowPx: 0, offenders: [], consoleErrors, failedRequests, screenshot: null }
      try {
        const res = await tab.goto(origin + page, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS })
        if (res && res.status() >= 400) check.loadError = `HTTP ${res.status()}`
        await tab.evaluate(() => document.fonts.ready)
        Object.assign(check, await tab.evaluate(measure))
        check.screenshot = `${slug(page)}-${width}-${scheme}.png`
        await tab.screenshot({ path: `${OUT}/screenshots/${check.screenshot}`, fullPage: true })
      } catch (e) {
        check.loadError ??= String(e.message ?? e).split('\n')[0]
      }
      checks.push(check)
      await context.close()
    }
  }
}
await browser.close()
server.kill()
finish(null, checks)
