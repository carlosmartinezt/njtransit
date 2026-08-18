// Stops the board can show.
//
// NJ Transit's full stop list ships with the GTFS feed behind the same
// developer login as BUSDV2. `npm run stops` pulls the real list into
// data/stops.json once credentials exist; until then this seed covers the
// terminals worth having a one-tap button for.
//
// IMPORTANT: the DepartureVision stop IDs below are seeded from NJ Transit's
// MyBus stop numbering and are marked `verified: false` until a live call
// confirms them. `GET /api/stops/verify` checks them against the real API.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const STOPS_FILE = join(HERE, '..', 'data', 'stops.json')

const SEED = [
  {
    // Confirmed live against getBusDV on 2026-08-18. This is the GTFS
    // stop_code for Port Authority Bus Terminal — BUSDV2 keys on stop_code,
    // not stop_id. The earlier 26126 was a guess and returns an empty board.
    id: '26229',
    name: 'Port Authority Bus Terminal',
    short: 'Port Authority',
    city: 'New York, NY',
    terminal: true,
    verified: true,
  },
  {
    id: '20372',
    name: 'George Washington Bridge Bus Station',
    short: 'GW Bridge',
    city: 'New York, NY',
    terminal: true,
    verified: false,
  },
  {
    id: '20925',
    name: 'Newark Penn Station',
    short: 'Newark Penn',
    city: 'Newark, NJ',
    terminal: true,
    verified: false,
  },
  {
    id: '21093',
    name: 'Hoboken Terminal',
    short: 'Hoboken',
    city: 'Hoboken, NJ',
    terminal: true,
    verified: false,
  },
]

let cached = null

/** Full stop list: the GTFS-derived file when present, else the seed. */
export function allStops() {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(STOPS_FILE, 'utf8'))
    if (Array.isArray(parsed) && parsed.length) {
      cached = parsed
      return cached
    }
  } catch {
    // No generated file yet — expected before `npm run stops` has been run.
  }
  cached = SEED
  return cached
}

export function findStop(id) {
  const wanted = String(id).trim()
  return allStops().find((s) => String(s.id) === wanted) ?? null
}

/** Terminals first, then name order — the picker is a short list, not a search. */
export function searchStops(q, limit = 25) {
  const stops = allStops()
  const needle = String(q ?? '').trim().toLowerCase()

  const matches = needle
    ? stops.filter(
        (s) =>
          s.name.toLowerCase().includes(needle) ||
          String(s.id).startsWith(needle) ||
          (s.city ?? '').toLowerCase().includes(needle),
      )
    : stops

  return matches
    .slice()
    .sort((a, b) => Number(Boolean(b.terminal)) - Number(Boolean(a.terminal)) || a.name.localeCompare(b.name))
    .slice(0, limit)
}

// Read lazily: ESM evaluates this module before index.mjs's body loads .env,
// so a top-level read would always miss PABT_STOP_ID.
export function defaultStopId() {
  return process.env.PABT_STOP_ID?.trim() || SEED[0].id
}
