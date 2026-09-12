// Remembered gates.
//
// DepartureVision only posts a gate once the terminal assigns one, which at
// Port Authority is often minutes before boarding — so the board shows "No
// gate" exactly when a rider is deciding where to walk. But gates barely move:
// the 6:47 PM 166T has left from gate 224 every weekday for months.
//
// So every gate the live API does report is written down, keyed by the trip,
// and a departure that arrives without one is filled from that history and
// labelled "usually" rather than passed off as posted fact.
//
// The store is a set of small Redis hashes per stop, each holding a count and a
// last-seen stamp per (key, gate). Counters rather than read-modify-write,
// because two function instances will record the same board and neither may
// lose the other's count.
//
// The trip hashes are bucketed by day type and hour of the scheduled departure,
// so a board reads only the hour or two it is actually showing. Port Authority
// alone already has ~6,000 remembered (trip, gate) pairs; one hash per stop
// would mean pulling all of it down on every cold instance and growing forever.
// Bucketed, a board is four or five small hashes in one pipelined round trip,
// and it stays that size however many months of history pile up.
//
// Losing the hash costs nothing but a few days of relearning, which is why this
// is a cache-shaped store and not a database.

import { store } from './store.mjs'
import { nyNow } from './time.mjs'

/** An observation loses half its weight every month, so a moved gate wins fast. */
const HALF_LIFE_DAYS = 30
/** Nothing unseen this long is worth keeping, or trusting. */
const MAX_AGE_DAYS = 120
/** Below this share of the weight the history is a coin flip, so say nothing. */
const MIN_CONFIDENCE = 0.6
/** One sighting is an anecdote — two on the same key is a pattern. */
const MIN_OBSERVATIONS = 2

const DAY = 86_400_000
/**
 * A trip sits on the board for the better part of an hour and is re-read every
 * few minutes. Counting each read would let one long-posted gate outweigh a
 * month of real days, so a trip only counts once per run. On one box this was a
 * Map; across instances it has to be a key only one of them can create.
 */
const REPEAT_WINDOW_MS = 6 * 60 * 60_000

/**
 * How long an instance reuses the history it already pulled. The history moves
 * in days, so a minute of staleness is invisible, and it turns the per-request
 * HGETALL into roughly one per instance per minute.
 */
const MEMO_MS = 60_000

const weekdayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
})

/**
 * Gates differ between weekday and weekend service far more than they differ
 * between two Tuesdays, so that's the split the key carries.
 */
function dayType(at) {
  const wd = weekdayFmt.format(new Date(at))
  if (wd === 'Sat') return 'sat'
  if (wd === 'Sun') return 'sun'
  return 'wk'
}

/** Scheduled departure as minutes past New York midnight, rounded to 5. */
function slotOf(ms) {
  const { hour, minute } = nyNow(ms)
  return String(Math.round((hour * 60 + minute) / 5) * 5)
}

/**
 * Three keys per departure, narrowest first. The trip key is the real answer —
 * this exact run leaves from this exact gate. The service and route keys back
 * it up for a trip that has never been seen with a gate, since most routes
 * board from one or two gates all day.
 *
 * The stop is the hash name, so unlike the file-backed version it isn't
 * repeated in every key.
 */
export function keysFor(d, at) {
  const service = d.service || d.route
  const keys = [`r|${d.route}`]
  if (service) keys.unshift(`s|${service}`)
  const when = d.scheduledAt ?? d.departsAt
  if (service && when != null) {
    keys.unshift(`t|${service}|${dayType(at)}|${slotOf(when)}`)
  }
  return keys
}

const BASIS = { t: 'trip', s: 'service', r: 'route' }

/**
 * One hash per stop of "trip X was already counted at gate Y at time T", rather
 * than a key per departure. A rush-hour board is ninety departures: as separate
 * keys that's ninety round trips every refresh, which is most of what this app
 * would spend on Redis. As one hash it's a read and a write.
 */
const seenHash = (stopId) => `njt:seen:${stopId}`

/**
 * Which hash a key lives in. Trip keys are bucketed by the hour they depart —
 * `t|166T|wk|1125` is the 18:00 hour on a weekday — so reading a board only
 * touches the hours on screen. Service and route keys are few enough per stop
 * to share one hash each.
 */
export function hashFor(stopId, key) {
  const parts = key.split('|')
  if (parts[0] === 't') {
    const hour = Math.floor(Number(parts[3]) / 60)
    return `njt:gates:${stopId}:t:${parts[2]}:${Number.isFinite(hour) ? hour : 'x'}`
  }
  return `njt:gates:${stopId}:${parts[0]}`
}

/** The hashes a board needs: its own hours, plus the two fallbacks. */
function hashesForBoard(stopId, departures, at) {
  const names = new Set([`njt:gates:${stopId}:s`, `njt:gates:${stopId}:r`])
  for (const d of departures) {
    for (const key of keysFor(d, at)) names.add(hashFor(stopId, key))
  }
  return [...names]
}

/**
 * Every hash a stop can have: two fallbacks and three day types times the 25
 * hour buckets a 5-minute slot can round into (23:58 rounds up to 24:00). Small
 * and fixed, so inspection and pruning never need SCAN.
 */
function allHashes(stopId) {
  const names = [`njt:gates:${stopId}:s`, `njt:gates:${stopId}:r`]
  for (const day of ['wk', 'sat', 'sun']) {
    for (let hour = 0; hour <= 24; hour++) names.push(`njt:gates:${stopId}:t:${day}:${hour}`)
  }
  return names
}

// ── reading ───────────────────────────────────────────────────────────────────

const memo = new Map() // hash name -> { at, fields }

/**
 * Flat hash fields back into `key -> { gates: { gate: { n, last } }, last }`.
 * Anything malformed is dropped rather than thrown on: a half-written field
 * should cost one remembered gate, not the whole board.
 */
function indexFields(fields) {
  const index = {}
  for (const [field, raw] of Object.entries(fields)) {
    const cut = field.lastIndexOf('#')
    if (cut < 0) continue
    const what = field.slice(cut + 1)
    const rest = field.slice(0, cut)
    const gateCut = rest.lastIndexOf('#')
    if (gateCut < 0) continue
    const key = rest.slice(0, gateCut)
    const gate = rest.slice(gateCut + 1)
    if (!key || !gate) continue

    const value = Number(raw)
    if (!Number.isFinite(value)) continue

    const rec = (index[key] ??= { gates: {}, last: 0 })
    const entry = (rec.gates[gate] ??= { n: 0, last: 0 })
    if (what === 'n') entry.n = value
    else if (what === 't') {
      entry.last = value
      if (value > rec.last) rec.last = value
    }
  }
  return index
}

/**
 * Read a set of hashes, reusing anything this instance pulled in the last
 * minute. The history moves in days, so a minute of staleness is invisible and
 * it turns a burst of requests into one round trip.
 */
async function readHashes(names, at) {
  const stale = names.filter((n) => {
    const hit = memo.get(n)
    return !hit || at - hit.at >= MEMO_MS
  })

  if (stale.length) {
    try {
      const results = await store().hgetallMany(stale)
      stale.forEach((name, i) => memo.set(name, { at, fields: results[i] ?? {} }))
    } catch (err) {
      // A board with live gates and no remembered ones still beats an error
      // page, so fall back to whatever this instance last saw.
      console.warn(`gate history: could not read (${err.message})`)
      for (const name of stale) if (!memo.has(name)) memo.set(name, { at, fields: {} })
    }
  }

  const fields = {}
  for (const name of names) Object.assign(fields, memo.get(name)?.fields ?? {})
  return indexFields(fields)
}

/** The remembered gates this board could possibly need. */
export async function loadGateIndex(stopId, departures, at = Date.now()) {
  return readHashes(hashesForBoard(stopId, departures, at), at)
}

/** Everything a stop has learned — for /api/gates, which exists to show it all. */
export async function loadFullGateIndex(stopId, at = Date.now()) {
  return readHashes(allHashes(stopId), at)
}

/**
 * Just the service and route fallbacks: two small hashes rather than all 77.
 * Enough for /api/health to say whether the history is there and being fed,
 * without pulling a few hundred KB every time something pings it.
 */
export async function loadSummaryGateIndex(stopId, at = Date.now()) {
  return readHashes([`njt:gates:${stopId}:s`, `njt:gates:${stopId}:r`], at)
}

function weight(entry, at) {
  const ageDays = (at - entry.last) / DAY
  return entry.n * Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
}

/**
 * The gate this departure usually leaves from, or null when the history is too
 * thin or too split to be worth showing.
 */
export function usualGate(index, d, at = Date.now()) {
  for (const key of keysFor(d, at)) {
    const rec = index[key]
    if (!rec) continue

    let best = null
    let total = 0
    for (const [gate, entry] of Object.entries(rec.gates)) {
      if (at - entry.last > MAX_AGE_DAYS * DAY) continue
      const w = weight(entry, at)
      total += w
      if (!best || w > best.w) best = { gate, w, entry }
    }
    if (!best || total <= 0) continue

    const confidence = best.w / total
    if (best.entry.n < MIN_OBSERVATIONS || confidence < MIN_CONFIDENCE) continue

    return {
      gate: best.gate,
      basis: BASIS[key[0]],
      confidence: Math.round(confidence * 100) / 100,
      observations: best.entry.n,
      lastSeenAt: best.entry.last,
    }
  }
  return null
}

/**
 * Fill in the gates NJ Transit didn't post, marking every one as remembered so
 * the UI can hedge the way a person would: "usually gate 224".
 */
export function applyUsualGates(index, departures, at = Date.now()) {
  let filled = 0
  for (const d of departures) {
    if (d.gate) {
      d.gateSource = 'live'
      continue
    }
    const guess = usualGate(index, d, at)
    if (!guess) continue
    d.gate = guess.gate
    d.gateSource = 'usual'
    d.gateBasis = guess.basis
    d.gateConfidence = guess.confidence
    d.gateObservations = guess.observations
    d.gateLastSeenAt = guess.lastSeenAt
    filled++
  }
  return filled
}

// ── writing ───────────────────────────────────────────────────────────────────

/**
 * Write down every gate the live API actually posted.
 *
 * Only live boards are recorded: filling a gate from history and then learning
 * from the fill would let one bad guess harden into a fact.
 *
 * The "count a trip once per run" rule is a Redis key only one instance can
 * create, so the request that wins does the counting and the other twenty
 * requests for the same board in the same minute do nothing.
 */
export async function recordGates(stopId, departures, at = Date.now()) {
  const posted = departures.filter((d) => d.gate && d.gateSource !== 'usual')
  if (!posted.length) return 0

  const s = store()
  const hash = seenHash(stopId)

  let seenBefore
  try {
    seenBefore = await s.hgetall(hash)
  } catch (err) {
    // Without the record of what's already counted, counting again would
    // inflate every gate on the board. Skip the pass; the next one recovers.
    console.warn(`gate history: could not read the counted set (${err.message})`)
    return 0
  }

  // hash name -> { increments, sets }: one board can touch a few hour buckets.
  const writes = new Map()
  const counted = {}
  let seen = 0

  for (const d of posted) {
    const field = `${d.id}#${d.gate}`
    const last = Number(seenBefore[field])
    if (Number.isFinite(last) && at - last < REPEAT_WINDOW_MS) continue

    counted[field] = String(at)
    seen++
    for (const key of keysFor(d, at)) {
      const name = hashFor(stopId, key)
      const w = writes.get(name) ?? { increments: {}, sets: {} }
      writes.set(name, w)
      const gateField = `${key}#${d.gate}`
      w.increments[`${gateField}#n`] = (w.increments[`${gateField}#n`] ?? 0) + 1
      w.sets[`${gateField}#t`] = String(at)
    }
  }

  if (!seen) return 0

  // Nothing here holds a lock, so two instances refreshing the same board in the
  // same instant could both count it. That costs one extra observation on a
  // counter that already decays — cheap next to a round trip per departure.
  try {
    await Promise.all([
      s.hbump(hash, { sets: counted }),
      ...[...writes].map(([name, w]) => s.hbump(name, w)),
    ])
    // Keep this instance's view current instead of waiting out the memo, or a
    // gate posted right now wouldn't be remembered for another minute.
    for (const name of writes.keys()) memo.delete(name)
  } catch (err) {
    console.warn(`gate history: could not record ${stopId} (${err.message})`)
    return 0
  }

  // Yesterday's trips are never coming back on this board. Dropped here, where
  // the whole set is already in hand, rather than as another scheduled job.
  const expired = Object.entries(seenBefore)
    .filter(([, t]) => at - Number(t) > REPEAT_WINDOW_MS)
    .map(([field]) => field)
  if (expired.length) {
    try {
      await s.hdel(hash, expired)
    } catch {
      // It only grows a little; the next pass tries again.
    }
  }

  return seen
}

/**
 * Drop everything past MAX_AGE_DAYS. The file-backed version pruned on every
 * write; here it is one pass a day from the cron, because pruning costs a write
 * round trip and a gate that moved four months ago is not urgent.
 */
export async function pruneGates(stopId, at = Date.now()) {
  const names = allHashes(stopId)
  const hashes = await store().hgetallMany(names)
  let dropped = 0

  await Promise.all(
    names.map(async (name, i) => {
      const dead = []
      for (const [key, rec] of Object.entries(indexFields(hashes[i] ?? {}))) {
        for (const [gate, entry] of Object.entries(rec.gates)) {
          if (at - entry.last > MAX_AGE_DAYS * DAY) {
            dead.push(`${key}#${gate}#n`, `${key}#${gate}#t`)
          }
        }
      }
      if (!dead.length) return
      await store().hdel(name, dead)
      memo.delete(name)
      dropped += dead.length / 2
    }),
  )

  return dropped
}

// ── inspection ────────────────────────────────────────────────────────────────

/** Shape of one stop's history, for /api/gates and /api/health. */
export function gateHistoryStats(index, at = Date.now()) {
  const keys = Object.entries(index)
  return {
    keys: keys.length,
    observations: keys.reduce(
      (sum, [, rec]) => sum + Object.values(rec.gates).reduce((s, e) => s + e.n, 0),
      0,
    ),
    oldestSeenAt: keys.reduce((min, [, r]) => Math.min(min, r.last), at),
    newestSeenAt: keys.reduce((max, [, r]) => Math.max(max, r.last), 0) || null,
    store: store().kind,
  }
}

/** Every remembered gate for one stop, newest first — for inspection. */
export function gateHistoryEntries(index, at = Date.now()) {
  return Object.entries(index)
    .map(([key, rec]) => {
      const parts = key.split('|')
      return {
        basis: BASIS[parts[0]],
        service: parts[1],
        dayType: parts[2] ?? null,
        slot: parts[3] ?? null,
        lastSeenAt: rec.last,
        gates: Object.entries(rec.gates)
          .map(([gate, e]) => ({
            gate,
            observations: e.n,
            lastSeenAt: e.last,
            weight: Math.round(weight(e, at) * 100) / 100,
          }))
          .sort((a, b) => b.weight - a.weight),
      }
    })
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}
