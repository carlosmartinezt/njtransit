// Board assembly: the part of the old server that wasn't HTTP plumbing.
//
// Every API function goes through here, so the caching, the call budget and the
// gate learning behave identically whether the caller is a rider's phone or the
// nightly cron.

import { NJTransitClient, NJTransitError, normalizeDepartures, PROD_URL, TEST_URL } from './njt.mjs'
import { sampleBusDV } from './sample.mjs'
import { findStop, defaultStopId } from './stops.mjs'
import { applyUsualGates, loadGateIndex, recordGates } from './gates.mjs'
import { store } from './store.mjs'

// 20s is short enough that a gate change reaches the phone quickly, and long
// enough that continuous polling costs ~4.3k calls/day against a 40k budget.
export const TTL_MS = Number(process.env.DEPARTURES_TTL_MS ?? 20_000)

// How long a board stays readable past its TTL, to be served stale when NJ
// Transit is down. A board 90 seconds old beats no board at all.
const STALE_TTL_SEC = 15 * 60

// Hard stop well under NJ Transit's published 40k/day so a runaway client
// can't get the account throttled.
const DAILY_CALL_CAP = Number(process.env.NJT_DAILY_CALL_CAP ?? 30_000)

// ── upstream client ───────────────────────────────────────────────────────────

let client
let clientBuilt = false

/**
 * Built lazily and kept on the instance: a warm function reuses both the client
 * and, through it, the NJ Transit token.
 */
export function njtClient() {
  if (clientBuilt) return client
  clientBuilt = true

  const username = process.env.NJT_USERNAME?.trim()
  const password = process.env.NJT_PASSWORD?.trim()
  if (!username || !password) {
    console.warn('⚠ NJT_USERNAME / NJT_PASSWORD not set — serving the sample board.')
    client = null
    return client
  }

  client = new NJTransitClient({
    baseUrl: process.env.NJT_ENV === 'test' ? TEST_URL : PROD_URL,
    username,
    password,
    // Instances are short-lived and there are many of them, so a token held
    // only in the heap would mean an authenticateUser call per cold start.
    // Shared in Redis, one token serves every instance for its whole life.
    tokenStore: {
      async get() {
        return store().get('njt:token')
      },
      async set(token, ttlMs) {
        await store().set('njt:token', token, { ttlSec: ttlMs / 1000 })
      },
    },
  })
  return client
}

export const isLive = () => njtClient() != null

// ── upstream call budget ──────────────────────────────────────────────────────

const dayKey = () => `njt:calls:${new Date().toISOString().slice(0, 10)}`

/**
 * Count one upstream call against today's cap, shared across instances.
 *
 * A store that's down must not take the board down with it, so a failed count
 * is logged and allowed: the cap is a safety net against runaway clients, not a
 * correctness requirement.
 */
export async function spendCall() {
  let calls
  try {
    calls = await store().incr(dayKey(), { ttlSec: 60 * 60 * 36 })
  } catch (err) {
    console.warn(`call budget unavailable, proceeding: ${err.message}`)
    return
  }
  if (calls > DAILY_CALL_CAP) {
    throw new NJTransitError(
      `Daily NJ Transit call cap (${DAILY_CALL_CAP}) reached; serving cache only.`,
      { status: 429 },
    )
  }
}

export async function callsToday() {
  try {
    return Number((await store().get(dayKey())) ?? 0)
  } catch {
    return null
  }
}

export const dailyCallCap = () => DAILY_CALL_CAP

// ── cache ─────────────────────────────────────────────────────────────────────

const inFlight = new Map() // key -> Promise, collapses bursts within one instance

/**
 * Cache by (stop, route, direction) with a short TTL. On upstream failure a
 * stale entry is served rather than an error.
 *
 * The cache is shared rather than per-process, which is what keeps the call
 * count flat: on the old box one Map served every rider, and here the only way
 * to get that back is to put it where every instance can see it. The CDN sits
 * in front of this too (see the Cache-Control on /api/departures), so most
 * requests never reach a function at all.
 */
async function cached(key, produce) {
  const cacheKey = `njt:board:${key}`
  let hit = null
  try {
    const raw = await store().get(cacheKey)
    if (raw) hit = JSON.parse(raw)
  } catch {
    // Unreadable cache is a miss, not a failure.
  }

  if (hit && Date.now() - hit.at < TTL_MS) {
    return { ...hit.value, cacheAgeMs: Date.now() - hit.at }
  }

  if (inFlight.has(key)) return inFlight.get(key)

  const p = (async () => {
    try {
      const value = await produce()
      const at = Date.now()
      try {
        await store().set(cacheKey, JSON.stringify({ at, value }), { ttlSec: STALE_TTL_SEC })
      } catch (err) {
        console.warn(`board cache write failed for ${key}: ${err.message}`)
      }
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

// ── board ─────────────────────────────────────────────────────────────────────

export async function buildBoard({ stopId, route, direction, ip }) {
  // `known: false` is how the client tells a stop we no longer list apart from
  // one that is simply quiet right now — a rider whose saved stop id was
  // retired gets moved back to the default instead of staring at an empty board.
  const match = findStop(stopId)
  const stop = match
    ? { ...match, known: true }
    : {
        id: stopId,
        name: `Stop ${stopId}`,
        short: `Stop ${stopId}`,
        city: null,
        terminal: false,
        known: false,
      }

  const key = `${stopId}|${route ?? ''}|${direction ?? ''}`

  return cached(key, async () => {
    const live = njtClient()
    let payload
    let source

    if (live) {
      await spendCall()
      payload = await live.getBusDV({ stop: stopId, route, direction, ip })
      source = 'live'
    } else {
      payload = sampleBusDV({ route })
      source = 'sample'
    }

    const at = Date.now()
    const { notice, departures } = normalizeDepartures(payload, { at })

    // Learn from what the terminal actually posted, then fill the blanks from
    // what it has posted before. Order matters: record first, so a remembered
    // gate can never be re-recorded as if it had been observed.
    if (source === 'live') await recordGates(stopId, departures, at)
    const index = await loadGateIndex(stopId, departures, at)
    const gatesFilled = applyUsualGates(index, departures, at)

    return {
      stop,
      source,
      generatedAt: at,
      notice,
      departures,
      // Distinct routes on the board, in the order a rider scans them.
      routes: [...new Set(departures.map((d) => d.route))].sort(compareRoutes),
      /** How many gates on this board came from history rather than NJ Transit. */
      gatesFilled,
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

export { defaultStopId }
