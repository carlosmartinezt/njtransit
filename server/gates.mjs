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
// The store is a small JSON file written back at most once a minute. Losing it
// costs nothing but a few days of relearning, which is why it isn't a database.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { nyNow } from './time.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, '..', 'data')
const FILE = process.env.GATE_HISTORY_FILE || join(DATA_DIR, 'gate-history.json')

/** An observation loses half its weight every month, so a moved gate wins fast. */
const HALF_LIFE_DAYS = 30
/** Nothing unseen this long is worth keeping, or trusting. */
const MAX_AGE_DAYS = 120
/** Below this share of the weight the history is a coin flip, so say nothing. */
const MIN_CONFIDENCE = 0.6
/** One sighting is an anecdote — two on the same key is a pattern. */
const MIN_OBSERVATIONS = 2

const DAY = 86_400_000
const FLUSH_MS = 60_000
/**
 * A trip sits on the board for the better part of an hour and is re-read every
 * few minutes. Counting each read would let one long-posted gate outweigh a
 * month of real days, so a trip only counts once per run.
 */
const REPEAT_WINDOW_MS = 6 * 60 * 60_000

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
 */
function keysFor(stopId, d, at) {
  const service = d.service || d.route
  const keys = [`r|${stopId}|${d.route}`]
  if (service) keys.unshift(`s|${stopId}|${service}`)
  const when = d.scheduledAt ?? d.departsAt
  if (service && when != null) {
    keys.unshift(`t|${stopId}|${service}|${dayType(at)}|${slotOf(when)}`)
  }
  return keys
}

const BASIS = { t: 'trip', s: 'service', r: 'route' }

// ── store ─────────────────────────────────────────────────────────────────────

/** key -> { gates: { [gate]: { n, last } }, last } */
let store = load()
let dirty = false
let flushTimer = null

function load() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    if (raw && typeof raw.keys === 'object') return raw.keys
  } catch {
    // No file yet, or a truncated one — either way, start over. The history
    // rebuilds itself from the next few boards.
  }
  return {}
}

function flush() {
  if (!dirty) return
  dirty = false
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const tmp = FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), keys: store }))
    // Rename so a crash mid-write can't leave half a file behind.
    renameSync(tmp, FILE)
  } catch (err) {
    console.warn(`gate history: could not save (${err.message})`)
  }
}

function scheduleFlush() {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, FLUSH_MS)
  flushTimer.unref?.()
}

/** Called on shutdown so the last few minutes of observation aren't lost. */
export function saveGateHistory() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  flush()
}

function weight(entry, at) {
  const ageDays = (at - entry.last) / DAY
  return entry.n * Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
}

function prune(at) {
  for (const [key, rec] of Object.entries(store)) {
    if (at - rec.last > MAX_AGE_DAYS * DAY) {
      delete store[key]
      continue
    }
    for (const [gate, entry] of Object.entries(rec.gates)) {
      if (at - entry.last > MAX_AGE_DAYS * DAY) delete rec.gates[gate]
    }
    if (Object.keys(rec.gates).length === 0) delete store[key]
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Write down every gate the live API actually posted.
 *
 * Only live boards are recorded: filling a gate from history and then learning
 * from the fill would let one bad guess harden into a fact.
 */
const recentlyCounted = new Map() // "stop|tripId|gate" -> at

export function recordGates(stopId, departures, at = Date.now()) {
  let seen = 0
  for (const d of departures) {
    if (!d.gate || d.gateSource === 'usual') continue

    const once = `${stopId}|${d.id}|${d.gate}`
    if (at - (recentlyCounted.get(once) ?? -Infinity) < REPEAT_WINDOW_MS) continue
    recentlyCounted.set(once, at)

    seen++
    for (const key of keysFor(stopId, d, at)) {
      const rec = (store[key] ??= { gates: {}, last: 0 })
      const entry = (rec.gates[d.gate] ??= { n: 0, last: 0 })
      entry.n++
      entry.last = at
      rec.last = at
    }
  }
  if (seen) {
    prune(at)
    for (const [k, t] of recentlyCounted) {
      if (at - t > REPEAT_WINDOW_MS) recentlyCounted.delete(k)
    }
    scheduleFlush()
  }
  return seen
}

/**
 * The gate this departure usually leaves from, or null when the history is too
 * thin or too split to be worth showing.
 */
export function usualGate(stopId, d, at = Date.now()) {
  for (const key of keysFor(stopId, d, at)) {
    const rec = store[key]
    if (!rec) continue

    let best = null
    let total = 0
    for (const [gate, entry] of Object.entries(rec.gates)) {
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
export function applyUsualGates(stopId, departures, at = Date.now()) {
  let filled = 0
  for (const d of departures) {
    if (d.gate) {
      d.gateSource = 'live'
      continue
    }
    const guess = usualGate(stopId, d, at)
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

/** Shape of the store, for /api/gates. */
export function gateHistoryStats(at = Date.now()) {
  const keys = Object.entries(store)
  return {
    keys: keys.length,
    observations: keys.reduce(
      (sum, [, rec]) => sum + Object.values(rec.gates).reduce((s, e) => s + e.n, 0),
      0,
    ),
    oldestSeenAt: keys.reduce((min, [, r]) => Math.min(min, r.last), at),
    newestSeenAt: keys.reduce((max, [, r]) => Math.max(max, r.last), 0) || null,
    file: FILE,
  }
}

/** Every remembered gate for one stop, newest first — for inspection. */
export function gateHistoryFor(stopId, at = Date.now()) {
  return Object.entries(store)
    .filter(([key]) => key.split('|')[1] === stopId)
    .map(([key, rec]) => {
      const parts = key.split('|')
      return {
        basis: BASIS[parts[0]],
        service: parts[2],
        dayType: parts[3] ?? null,
        slot: parts[4] ?? null,
        lastSeenAt: rec.last,
        gates: Object.entries(rec.gates)
          .map(([gate, e]) => ({ gate, observations: e.n, lastSeenAt: e.last, weight: Math.round(weight(e, at) * 100) / 100 }))
          .sort((a, b) => b.weight - a.weight),
      }
    })
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}
