// Dev helper: capture the board at a few sizes and states so design changes can
// be reviewed without a device. Not part of the build.
//
//   node scripts/shots.mjs [baseUrl] [outDir]

import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:5183'
const OUT = process.argv[3] ?? '/tmp/njt-shots'

// Reuse whatever chromium is already in the Playwright cache rather than
// downloading another one.
function findChromium() {
  const root = `${process.env.HOME}/.cache/ms-playwright`
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith('chromium-') || d.startsWith('mcp-chrom'))
    .sort()
    .reverse()

  const candidates = [
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome-linux/headless_shell',
    'chrome-headless-shell-linux64/chrome-headless-shell',
  ]

  for (const d of dirs) {
    for (const rel of candidates) {
      const p = join(root, d, rel)
      if (existsSync(p)) return p
    }
  }
  return undefined
}

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? findChromium(),
  args: ['--no-sandbox'],
})

const shots = [
  { name: 'mobile', width: 414, height: 896 },
  { name: 'small', width: 360, height: 780 },
  { name: 'desktop', width: 900, height: 1000 },
]

for (const s of shots) {
  const page = await browser.newPage({
    viewport: { width: s.width, height: s.height },
    deviceScaleFactor: 2,
  })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.next, .empty', { timeout: 10_000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, `${s.name}.png`) })

  if (s.name === 'mobile') {
    await page.screenshot({ path: join(OUT, 'mobile-full.png'), fullPage: true })

    // Sorted by route.
    await page.getByRole('button', { name: 'By route' }).click()
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(OUT, 'mobile-by-route.png') })
    await page.getByRole('button', { name: 'By time' }).click()

    // Stop picker.
    await page.locator('.hdr__stop').click()
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(OUT, 'mobile-picker.png') })
    await page.keyboard.press('Escape')

    // Offline board.
    await page.context().setOffline(true)
    await page.waitForTimeout(200)
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(OUT, 'mobile-offline.png') })
    await page.context().setOffline(false)
  }

  await page.close()
}

await browser.close()
console.log(`✓ shots in ${OUT}`)
