export interface Departure {
  id: string
  route: string
  destination: string
  /** Terminal gate, or null for stops that don't have one. */
  gate: string | null
  /** Epoch millis for the time the bus actually leaves (predicted when known). */
  departsAt: number | null
  scheduledAt: number | null
  /** NJ Transit's own wording when it isn't a clock time, e.g. "APPROACHING". */
  statusText: string | null
  /** Minutes behind schedule; negative means early. */
  delayMin: number | null
  /** True when NJ Transit is tracking a vehicle, not just reading the timetable. */
  isLive: boolean
  vehicle: string | null
  load: 'light' | 'medium' | 'heavy' | null
  remarks: string | null
}

export interface Stop {
  id: string
  name: string
  short: string
  city: string | null
  terminal?: boolean
  verified?: boolean
}

export interface Board {
  stop: Stop
  /** "live" from NJ Transit, "sample" when credentials aren't configured yet. */
  source: 'live' | 'sample'
  generatedAt: number
  notice: string | null
  departures: Departure[]
  routes: string[]
  cacheAgeMs?: number
  /** Set when the server fell back to a stale copy after an upstream failure. */
  degraded?: boolean
  error?: string
}

export type SortMode = 'time' | 'route'

/** Where a rendered board came from, which drives how stale the UI says it is. */
export type Freshness = 'live' | 'cached' | 'offline'
