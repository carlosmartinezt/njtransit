import type { Departure, SortMode } from './types'

/** Route "9" before "111" before "190A". */
export function compareRoutes(a: string, b: string): number {
  const na = parseInt(a, 10)
  const nb = parseInt(b, 10)
  if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b)
  return na - nb || a.localeCompare(b)
}

// Route is the tiebreak so two buses leaving the same minute keep a stable
// order — otherwise the hero would swap on every re-sort.
const byTime = (a: Departure, b: Departure) =>
  (a.departsAt ?? Infinity) - (b.departsAt ?? Infinity) ||
  compareRoutes(a.route, b.route)

/**
 * Order the board.
 *
 * Sorting by route still orders each route's own departures by time, so the
 * first row under "190" is the next 190 — grouping by route should never bury
 * the soonest bus.
 */
export function sortDepartures(departures: Departure[], mode: SortMode): Departure[] {
  const out = departures.slice()
  if (mode === 'route') {
    out.sort((a, b) => compareRoutes(a.route, b.route) || byTime(a, b))
  } else {
    out.sort(byTime)
  }
  return out
}

export interface FilterOptions {
  pinnedRoutes: string[]
  onlyPinned: boolean
  /** Drop departures that left more than this many minutes ago. */
  graceMin?: number
  now: number
}

/**
 * Hide buses that have already gone, and optionally everything the rider
 * doesn't take. A departure keeps its slot for a minute after its time so a
 * bus doesn't vanish while the rider is walking to the gate.
 */
export function filterDepartures(
  departures: Departure[],
  { pinnedRoutes, onlyPinned, graceMin = 1, now }: FilterOptions,
): Departure[] {
  const pinned = new Set(pinnedRoutes)

  return departures.filter((d) => {
    if (onlyPinned && pinned.size > 0 && !pinned.has(d.route)) return false
    if (d.departsAt == null) return true // status-only rows still matter
    return d.departsAt >= now - graceMin * 60_000
  })
}

/** Routes present on the board, for the filter row. */
export function routesOf(departures: Departure[]): string[] {
  return [...new Set(departures.map((d) => d.route))].sort(compareRoutes)
}

/**
 * Urgency drives the visual treatment: "boarding" gets the amber plate,
 * "soon" gets emphasis, everything else stays quiet.
 */
export type Urgency = 'boarding' | 'soon' | 'later'

export function urgencyOf(d: Departure, now: number): Urgency {
  if (d.departsAt == null) return 'later'
  const min = Math.floor((d.departsAt - now) / 60_000)
  if (min <= 3) return 'boarding'
  if (min <= 10) return 'soon'
  return 'later'
}
