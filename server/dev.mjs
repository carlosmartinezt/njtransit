// Local API host. Development only — production is Vercel.
//
// The functions under api/ are plain Node request handlers, so running them
// locally needs nothing more than a router and a .env reader. `vercel dev` does
// the same job with the real routing rules, and is the better check before a
// deploy; this exists so a clean checkout can run `npm run dev` without the
// Vercel CLI or a linked project.

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Minimal KEY=VALUE .env reader — avoids a dependency for six variables. */
function loadDotEnv(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line)
    if (!m) continue
    const [, key, valueRaw] = m
    if (process.env[key] !== undefined) continue
    process.env[key] = valueRaw.replace(/^["']|["']$/g, '')
  }
}

loadDotEnv(join(HERE, '..', '.env'))

const PORT = Number(process.env.PORT ?? 3057)
const HOST = process.env.HOST ?? '127.0.0.1'

// Imported after .env so the modules see the credentials they read at load.
const routes = new Map(
  Object.entries({
    '/api/departures': '../api/departures.js',
    '/api/stops': '../api/stops.js',
    '/api/stops/verify': '../api/stops/verify.js',
    '/api/gates': '../api/gates.js',
    '/api/health': '../api/health.js',
    '/api/cron/sample': '../api/cron/sample.js',
  }),
)

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/'
  const mod = routes.get(path)

  if (!mod) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: 'Not found' }))
  }

  const { default: handler } = await import(mod)
  await handler(req, res)
})

server.listen(PORT, HOST, () => {
  console.log(`▶ njtransit api (dev) on http://${HOST}:${PORT}`)
  console.log(`  routes: ${[...routes.keys()].join(', ')}`)
})
