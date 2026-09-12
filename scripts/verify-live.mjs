// Smoke-test the deployed site in a real browser: board renders, service worker
// registers, PWA manifest is accepted, no console errors.
//
//   node scripts/verify-live.mjs [url]

import { chromium } from 'playwright-core'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function findChromium() {
  const root = `${process.env.HOME}/.cache/ms-playwright`
  try {
    const dirs = readdirSync(root)
      .filter((x) => x.startsWith('chromium-') || x.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse()
    for (const d of dirs) {
      for (const rel of [
        'chrome-linux64/chrome',
        'chrome-linux/chrome',
        'chrome-headless-shell-linux64/chrome-headless-shell',
      ]) {
        const p = join(root, d, rel)
        if (existsSync(p)) return p
      }
    }
  } catch {
    // No Playwright cache on this machine.
  }
  // The system browser does the job, and npm ci updating playwright-core
  // shouldn't be what stops a deploy from being checked.
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(p)) return p
  }
}

const URL_ = process.argv[2] ?? 'https://njtransit.carlosmartinezt.com'
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] })
// Deployment Protection covers every *.vercel.app URL on this project, so a
// browser check of a preview needs the local development token as a header.
// `vercel env pull .env.local` refreshes it; without one this runs unauthenticated,
// which is what a check of the public custom domain wants.
const bypass = process.env.VERCEL_OIDC_TOKEN
  ? { 'x-vercel-trusted-oidc-idp-token': process.env.VERCEL_OIDC_TOKEN }
  : {}

const ctx = await browser.newContext({
  viewport: { width: 414, height: 896 },
  extraHTTPHeaders: bypass,
})
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

// Against a protected *.vercel.app URL this always fails, and not because the
// worker is broken: the browser fetches the worker script outside the page, so
// it carries no bypass header, and Deployment Protection answers with a 302 to
// the SSO page. A service worker script behind a redirect is disallowed, so
// registration is refused. Check the worker on the public custom domain.
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
