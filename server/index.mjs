// API proxy for the Port Authority departure board.
//
// Caddy serves the built SPA from dist/ and reverse-proxies /api/* here. This
// process is the only thing that holds NJ Transit credentials, and the only
// thing that talks to pcsdata.njtransit.com.
//
// Without NJT_USERNAME / NJT_PASSWORD it serves a clearly-labelled sample board
// through the identical code path, so the app is fully usable before
// credentials arrive.

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { NJTransitClient, NJTransitError, normalizeDepartures, PROD_URL, TEST_URL } from './njt.mjs'
import { sampleBusDV } from './sample.mjs'
import { allStops, findStop, searchStops, DEFAULT_STOP_ID } from './stops.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── config ────────────────────────────────────────────────────────────────────

loadDotEnv(join(HERE, '..', '.env'))

const PORT = Number(process.env.PORT ?? 3057)
const HOST = process.env.HOST ?? '127.0.0.1'

// 20s is short enough that a gate change reaches the phone quickly, and long
// enough that continuous polling costs ~4.3k calls/day against a 40k budget.
const TTL_MS = Number(process.env.DEPARTURES_TTL_MS ?? 20_000)

// Hard stop well under NJ Transit's published 40k/day so a runaway client
// can't get the account throttled.
const DAILY_CALL_CAP = Number(process.env.NJT_DAILY_CALL_CAP ?? 30_000)

const client = buildClient()

function buildClient() {
  const username = process.env.NJT_USERNAME?.trim()
  const password = process.env.NJT_PASSWORD?.trim()
  if (!username || !password) {
    console.warn(
      '⚠ NJT_USERNAME / NJT_PASSWORD not set — serving the sample board.\n' +
        '  Add them to .env and restart to go live.',
    )
    return null
  }
  const baseUrl = process.env.NJT_ENV === 'test' ? TEST_URL : PROD_URL
  console.log(`✓ NJ Transit credentials loaded for ${username} → ${baseUrl}`)
  return new NJTransitClient({ baseUrl, username, password })
}

/** Minimal KEY=VALUE .env reader — avoids a dependency for four variables. */
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

// ── upstream call budget ──────────────────────────────────────────────────────

const budget = { day: null, calls: 0 }

function spendCall() {
  const today = new Date().toISOString().slice(0, 10)
  if (budget.day !== today) {
    budget.day = today
    budget.calls = 0
  }
  if (budget.calls >= DAILY_CALL_CAP) {
    throw new NJTransitError(
      `Daily NJ Transit call cap (${DAILY_CALL_CAP}) reached; serving cache only.`,
      { status: 429 },
    )
  }
  budget.calls++
}

// ── cache + single flight ─────────────────────────────────────────────────────

const cache = new Map() // key -> { at, value }
const inFlight = new Map() // key -> Promise

/**
 * Cache by (stop, route, direction) with a short TTL, and collapse concurrent
 * identical requests. On upstream failure a stale entry is served rather than
 * an error — a board that's 90 seconds old beats no board at all.
 */
async function cached(key, produce) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { ...hit.value, cacheAgeMs: Date.now() - hit.at }
  }

  if (inFlight.has(key)) return inFlight.get(key)

  const p = (async () => {
    try {
      const value = await produce()
      cache.set(key, { at: Date.now(), value })
      return { ...value, cacheAgeMs: 0 }
    } catch (err) {
      if (hit) {
        console.warn(`upstream failed for ${key}, serving stale: ${err.message}`)
        return {
          ...hit.value,
          cacheAgeMs: Date.now() - hit.at,
          degraded: true,
          error: err.message,
        }
      }
      throw err
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, p)
  return p
}

// ── board assembly ────────────────────────────────────────────────────────────

async function buildBoard({ stopId, route, direction, ip }) {
  const stop = findStop(stopId) ?? {
    id: stopId,
    name: `Stop ${stopId}`,
    short: `Stop ${stopId}`,
    city: null,
    terminal: false,
  }

  const key = `${stopId}|${route ?? ''}|${direction ?? ''}`

  return cached(key, async () => {
    let payload
    let source

    if (client) {
      spendCall()
      payload = await client.getBusDV({ stop: stopId, route, direction, ip })
      source = 'live'
    } else {
      payload = sampleBusDV({ route })
      source = 'sample'
    }

    const at = Date.now()
    const { notice, departures } = normalizeDepartures(payload, { at })

    return {
      stop,
      source,
      generatedAt: at,
      notice,
      departures,
      // Distinct routes on the board, in the order a rider scans them.
      routes: [...new Set(departures.map((d) => d.route))].sort(compareRoutes),
    }
  })
}

/** Route "9" sorts before "111" before "190A" — numeric where possible. */
export function compareRoutes(a, b) {
  const na = parseInt(a, 10)
  const nb = parseInt(b, 10)
  if (Number.isNaN(na) || Number.isNaN(nb)) return String(a).localeCompare(String(b))
  return na - nb || String(a).localeCompare(String(b))
}

// ── http ──────────────────────────────────────────────────────────────────────

function send(res, status, body, extraHeaders = {}) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  })
  res.end(json)
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim()
  return req.socket.remoteAddress ?? ''
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'Method not allowed' })
  }

  try {
    if (path === '/api/health') {
      return send(res, 200, {
        ok: true,
        source: client ? 'live' : 'sample',
        upstreamCallsToday: budget.calls,
        dailyCallCap: DAILY_CALL_CAP,
        cachedBoards: cache.size,
        defaultStopId: DEFAULT_STOP_ID,
        uptimeSec: Math.round(process.uptime()),
      })
    }

    if (path === '/api/stops') {
      const q = url.searchParams.get('q') ?? ''
      return send(res, 200, {
        defaultStopId: DEFAULT_STOP_ID,
        stops: searchStops(q),
      }, { 'Cache-Control': 'public, max-age=3600' })
    }

    // Confirms the seeded DepartureVision stop IDs against the real API.
    // Needs credentials; reports per-stop rather than failing as a whole.
    if (path === '/api/stops/verify') {
      if (!client) {
        return send(res, 503, {
          error: 'No NJ Transit credentials configured, so stop IDs cannot be verified.',
        })
      }
      const results = []
      for (const stop of allStops().filter((s) => s.terminal)) {
        try {
          spendCall()
          const payload = await client.getBusDV({ stop: stop.id, ip: clientIp(req) })
          const { departures, notice } = normalizeDepartures(payload)
          results.push({
            id: stop.id,
            name: stop.name,
            ok: departures.length > 0,
            departures: departures.length,
            sampleRoutes: [...new Set(departures.map((d) => d.route))].slice(0, 6),
            notice,
          })
        } catch (err) {
          results.push({ id: stop.id, name: stop.name, ok: false, error: err.message })
        }
      }
      return send(res, 200, { results })
    }

    if (path === '/api/departures') {
      const stopId = (url.searchParams.get('stop') || DEFAULT_STOP_ID).trim()
      const route = url.searchParams.get('route')?.trim() || undefined
      const direction = url.searchParams.get('direction')?.trim() || undefined

      if (!/^[A-Za-z0-9_-]{1,16}$/.test(stopId)) {
        return send(res, 400, { error: 'Invalid stop id' })
      }

      const board = await buildBoard({ stopId, route, direction, ip: clientIp(req) })
      return send(res, 200, board)
    }

    return send(res, 404, { error: 'Not found' })
  } catch (err) {
    const status = err instanceof NJTransitError ? err.status : 500
    console.error(`${path} failed:`, err)
    return send(res, status, {
      error: err.message ?? 'Unexpected error',
      // Lets the client show a board-shaped empty state instead of a raw error.
      departures: [],
    })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`▶ njtransit api on http://${HOST}:${PORT}  (default stop ${DEFAULT_STOP_ID})`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
  })
}
