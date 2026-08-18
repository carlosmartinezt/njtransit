// Client for NJ Transit's BUSDV2 (DepartureVision) API.
//
// Protocol, confirmed against NJ Transit's published developer API:
//   POST {base}authenticateUser   x-www-form-urlencoded  username, password
//                                 -> { Authenticated: "True", UserToken: "..." }
//   POST {base}getBusDV           multipart/form-data     token, stop, direction, route, ip
//                                 -> { message: {...}, DVTrip: [...] }
//
// Credentials live only in this process. The browser never sees them, which is
// also why the SPA cannot call NJ Transit directly.

import { parseDepartureTime } from './time.mjs'

export const PROD_URL = 'https://pcsdata.njtransit.com/api/BUSDV2/'
export const TEST_URL = 'https://testpcsdata.njtransit.com/api/BUSDV2/'

const USER_AGENT = 'njtransit-board/1.0 (+https://njtransit.carlosmartinezt.com)'

export class NJTransitError extends Error {
  constructor(message, { status = 502, retryable = false } = {}) {
    super(message)
    this.name = 'NJTransitError'
    this.status = status
    this.retryable = retryable
  }
}

export class NJTransitClient {
  #token = null
  #tokenAt = 0
  #authInFlight = null

  constructor({ baseUrl = PROD_URL, username, password, tokenTtlMs = 30 * 60_000 }) {
    if (!username || !password) {
      throw new Error('NJTransitClient requires a username and password')
    }
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
    this.username = username
    this.password = password
    this.tokenTtlMs = tokenTtlMs
  }

  get hasToken() {
    return this.#token != null && Date.now() - this.#tokenAt < this.tokenTtlMs
  }

  /**
   * Fetch a token, collapsing concurrent callers onto one request so a burst of
   * board loads after a restart doesn't spend several of the day's API calls.
   */
  async #authenticate({ force = false } = {}) {
    if (!force && this.hasToken) return this.#token
    if (this.#authInFlight) return this.#authInFlight

    this.#authInFlight = (async () => {
      const body = new URLSearchParams({
        username: this.username,
        password: this.password,
      })

      const res = await fetch(this.baseUrl + 'authenticateUser', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          'User-Agent': USER_AGENT,
          Accept: '*/*',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      })

      const text = await res.text()
      if (!res.ok) {
        throw new NJTransitError(
          `authenticateUser returned ${res.status}`,
          { status: res.status === 401 ? 401 : 502 },
        )
      }

      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new NJTransitError(`authenticateUser returned non-JSON: ${text.slice(0, 200)}`)
      }

      if (String(json.Authenticated).toLowerCase() !== 'true' || !json.UserToken) {
        throw new NJTransitError(
          'NJ Transit rejected the credentials. Check NJT_USERNAME / NJT_PASSWORD.',
          { status: 401 },
        )
      }

      this.#token = json.UserToken
      this.#tokenAt = Date.now()
      return this.#token
    })()

    try {
      return await this.#authInFlight
    } finally {
      this.#authInFlight = null
    }
  }

  async #call(method, fields, { retryOnAuth = true } = {}) {
    const token = await this.#authenticate()

    const form = new FormData()
    form.set('token', token)
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') form.set(k, String(v))
    }

    const res = await fetch(this.baseUrl + method, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      body: form,
      signal: AbortSignal.timeout(15_000),
    })

    const text = await res.text()

    if (!res.ok) {
      throw new NJTransitError(`${method} returned ${res.status}`, {
        status: 502,
        retryable: res.status >= 500,
      })
    }

    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new NJTransitError(`${method} returned non-JSON: ${text.slice(0, 200)}`)
    }

    // An expired token comes back as a normal 200 with an error message, so the
    // only way to detect it is to read the message and retry once.
    const msg = String(json?.message?.message ?? json?.message ?? '')
    if (retryOnAuth && /token|expire|authenticat|invalid/i.test(msg)) {
      await this.#authenticate({ force: true })
      return this.#call(method, fields, { retryOnAuth: false })
    }

    return json
  }

  /** Raw DepartureVision payload for a stop. */
  async getBusDV({ stop, direction, route, ip }) {
    return this.#call('getBusDV', { stop, direction, route, ip })
  }

  /** Nearby vehicle positions — used to tell "tracked" buses from scheduled ones. */
  async getVehicleLocations({ lat, lon, radius, mode = 'BUS' }) {
    return this.#call('getVehicleLocations', { lat, lon, radius, mode })
  }
}

const str = (v) => (v == null ? '' : String(v).trim())

/** Collapse the runs of whitespace and stray casing in NJT destination headers. */
function cleanText(v) {
  return str(v).replace(/\s+/g, ' ').trim()
}

/**
 * BUSDV2 fills absent fields with the literal strings "EMPTY" and "no data"
 * instead of leaving them blank, so every optional field has to be read through
 * this or the sentinel lands on the board as if it were real content.
 */
const ABSENT = new Set(['', '-', '--', 'N/A', 'TBD', 'EMPTY', 'NO DATA', 'NULL'])
function present(v) {
  const s = cleanText(v)
  return ABSENT.has(s.toUpperCase()) ? '' : s
}

/**
 * NJ Transit uses "lanegate" for both terminal gates and street stops, and at
 * Port Authority it appends the boarding position: "212_1" is gate 212, lane 1.
 * Riders navigate by the gate, so keep that and drop the suffix. Street stops
 * arrive as "GATE 225" or a bare number; absent ones as "EMPTY".
 */
function normalizeGate(raw) {
  const s = present(raw).toUpperCase()
  if (!s) return null
  const base = s.split('_')[0].trim()
  if (!base) return null
  const m = /(?:GATE|LANE|BAY)?\s*([A-Z]?\d{1,4}[A-Z]?)$/.exec(base)
  return m ? m[1] : base
}

/**
 * Map NJT's passenger-load codes onto something a rider understands.
 * Unknown codes pass through as null rather than guessing.
 */
function normalizeLoad(raw) {
  const s = present(raw).toUpperCase()
  if (!s) return null
  if (/^(1|LIGHT|MANY SEATS)/.test(s)) return 'light'
  if (/^(2|MEDIUM|MODERATE|FEW SEATS)/.test(s)) return 'medium'
  if (/^(3|HEAVY|FULL|CROWDED|STANDING)/.test(s)) return 'heavy'
  return null
}

/** NJT returns a bare object when a stop has exactly one departure. */
function asTrips(payload) {
  const raw = payload?.DVTrip ?? payload?.dvTrip ?? payload?.trips ?? []
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return [raw]
  return []
}

/**
 * Turn a raw BUSDV2 payload into the shape the board renders.
 *
 * Every field the UI depends on is derived here so the client stays dumb and
 * the same normalization applies to live data, cached data, and sample data.
 */
export function normalizeDepartures(payload, { at = Date.now() } = {}) {
  // BUSDV2 sends the banner as either a bare string or {message: "..."},
  // and an empty board as {message: {message: null}} — so unwrap one level
  // and only keep a string. Coercing the object itself yields "[object Object]".
  const rawNotice = payload?.message
  const noticeText = typeof rawNotice === 'string' ? rawNotice : rawNotice?.message
  const notice = (typeof noticeText === 'string' ? cleanText(noticeText) : '') || null

  const departures = asTrips(payload)
    .map((t, i) => {
      const scheduledRaw = str(t.sched_dep_time ?? t.schedDepTime)
      const predictedRaw = str(t.departuretime ?? t.departureTime)

      const scheduled = parseDepartureTime(scheduledRaw, at)
      const predicted = parseDepartureTime(predictedRaw, at)

      // "Live" means NJT gave a prediction that differs from the timetable, or
      // attached a vehicle to the trip. Otherwise it's just the schedule.
      const vehicle = present(t.vehicle_id ?? t.vehicleID) || null
      const isLive = Boolean(vehicle) || (predicted != null && predicted !== scheduled)

      const departsAt = predicted ?? scheduled
      const delayMin =
        predicted != null && scheduled != null
          ? Math.round((predicted - scheduled) / 60_000)
          : null

      return {
        id:
          str(t.internal_trip_number ?? t.internalTripNum) ||
          `${str(t.public_route)}-${scheduledRaw || predictedRaw}-${i}`,
        route: cleanText(t.public_route ?? t.publicRoute) || '—',
        destination: cleanText(t.header ?? t.Header) || '',
        gate: normalizeGate(t.lanegate ?? t.laneGate),
        departsAt,
        scheduledAt: scheduled,
        // Kept so the UI can show NJT's own wording ("APPROACHING", "DELAYED")
        // when it isn't a parseable clock time.
        statusText: predicted == null && predictedRaw ? predictedRaw : null,
        delayMin,
        isLive,
        vehicle,
        load: normalizeLoad(t.passload ?? t.passLoad),
        remarks: present(t.remarks) || null,
      }
    })
    // A board with no usable time is noise; keep NJT's status text only when it
    // at least names a route.
    .filter((d) => d.departsAt != null || d.statusText)
    .sort((a, b) => (a.departsAt ?? Infinity) - (b.departsAt ?? Infinity))

  return { notice, departures }
}
