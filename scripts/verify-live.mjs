// Smoke-test the deployed site in a real browser: board renders, service worker
// registers, PWA manifest is accepted, no console errors.
//
//   node scripts/verify-live.mjs [url]

import { chromium } from 'playwright-core'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function findChromium() {
  const root = `${process.env.HOME}/.cache/ms-playwright`
  for (const d of readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(root, d, rel)
      if (existsSync(p)) return p
    }
  }
}

const URL_ = process.argv[2] ?? 'https://njtransit.carlosmartinezt.com'
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } })
const page = await ctx.newPage()

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(String(e)))

const fail = (m) => {
  console.error('  ✗ ' + m)
  process.exitCode = 1
}

await page.goto(URL_, { waitUntil: 'networkidle', timeout: 30_000 })
await page.waitForSelector('.next', { timeout: 15_000 })

const rows = await page.locator('.row').count()
const gate = (await page.locator('.plate__value').first().textContent())?.trim()
const stop = (await page.locator('.hdr__name').textContent())?.trim()
console.log(`board:   stop="${stop}" rows=${rows} heroGate=${gate}`)
if (rows === 0) fail('no departures rendered')

await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 20_000 })
  .then(() => console.log('sw:      controlling'))
  .catch(() => fail('service worker never took control'))

// The manifest must actually parse for Add to Home Screen to work.
const manifest = await page.evaluate(async () => {
  const href = document.querySelector('link[rel="manifest"]')?.getAttribute('href')
  if (!href) return { ok: false, why: 'no manifest link' }
  const res = await fetch(href)
  const type = res.headers.get('content-type')
  try {
    const json = await res.json()
    return { ok: true, type, name: json.name, icons: json.icons?.length }
  } catch (e) {
    return { ok: false, why: String(e), type }
  }
})
console.log(`manifest: ${JSON.stringify(manifest)}`)
if (!manifest.ok) fail(`manifest not usable: ${manifest.why}`)

// Ticket link must point at the official app.
const ticket = await page.locator('.btn--amber').getAttribute('href')
console.log(`tickets: ${ticket}`)
if (!/njtransit\.com|apps\.apple\.com|play\.google\.com/.test(ticket ?? '')) {
  fail('tickets link does not point at NJ TRANSIT')
}

console.log(`console errors: ${errors.length}`)
for (const e of errors.slice(0, 5)) console.log('   ! ' + e)
if (errors.length) fail('console errors present')

await page.screenshot({ path: '/tmp/njt-shots/live.png' })
await browser.close()
if (!process.exitCode) console.log('\n✓ live site verified')
