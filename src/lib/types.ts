export interface Departure {
  id: string
  /** The route family NJT bills the trip as, e.g. "166" — what the chips filter on. */
  route: string
  /** The exact service, e.g. "166X". Equals `route` unless NJT runs variants. */
  service: string
  destination: string
  /** Terminal gate, or null when neither NJ Transit nor history has one. */
  gate: string | null
  /**
   * Where `gate` came from: "live" is posted on the terminal's board right now,
   * "usual" is remembered from previous days and must be hedged in the UI.
   */
  gateSource?: 'live' | 'usual'
  /** For a remembered gate: which key matched — this trip, service, or route. */
  gateBasis?: 'trip' | 'service' | 'route'
  /** Share of recent sightings that agreed on this gate, 0–1. */
  gateConfidence?: number
  gateObservations?: number
  gateLastSeenAt?: number
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
  /** False when the server doesn't list this stop — usually a stale saved id. */
  known?: boolean
}

export interface Board {
  stop: Stop
  /** "live" from NJ Transit, "sample" when credentials aren't configured yet. */
  source: 'live' | 'sample'
  generatedAt: number
  notice: string | null
  departures: Departure[]
  routes: string[]
  /** Gates on this board that came from history rather than NJ Transit. */
  gatesFilled?: number
  cacheAgeMs?: number
  /** Set when the server fell back to a stale copy after an upstream failure. */
  degraded?: boolean
  error?: string
}

export type SortMode = 'time' | 'route'

/** Where a rendered board came from, which drives how stale the UI says it is. */
export type Freshness = 'live' | 'cached' | 'offline'
