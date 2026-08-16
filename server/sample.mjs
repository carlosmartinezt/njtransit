// Sample board used when NJ Transit credentials aren't configured.
//
// It emits the same raw DVTrip shape the real API returns, so it runs through
// exactly the same normalization the live path does — the app is fully
// exercisable now, and swapping in credentials changes nothing but the source.
// Every response built from this is tagged source:"sample" and the UI says so.

import { nyNow } from './time.mjs'

// Real NJ Transit routes out of Port Authority, with the gate ranges they
// actually use, so the sample board reads like the real thing.
const PABT_ROUTES = [
  { route: '190', dest: 'PATERSON', gate: '223', headwayMin: 10 },
  { route: '191', dest: 'WILLOWBROOK', gate: '221', headwayMin: 20 },
  { route: '192', dest: 'WAYNE — WILLOWBROOK', gate: '222', headwayMin: 30 },
  { route: '194', dest: 'WILLOWBROOK PARK & RIDE', gate: '224', headwayMin: 25 },
  { route: '199', dest: 'PATERSON — BROADWAY', gate: '225', headwayMin: 15 },
  { route: '320', dest: 'GARDEN STATE PLAZA', gate: '213', headwayMin: 12 },
  { route: '321', dest: 'PARAMUS — RIDGEWOOD', gate: '214', headwayMin: 35 },
  { route: '163', dest: 'RIDGEWOOD via RT 17', gate: '211', headwayMin: 18 },
  { route: '166', dest: 'DUMONT via RT 4', gate: '212', headwayMin: 14 },
  { route: '167', dest: 'HARRINGTON PARK', gate: '215', headwayMin: 22 },
  { route: '111', dest: 'OLD BRIDGE', gate: '406', headwayMin: 28 },
  { route: '126', dest: 'HOBOKEN', gate: '226', headwayMin: 8 },
  { route: '139', dest: 'LAKEWOOD', gate: '411', headwayMin: 40 },
]

const pad = (n) => String(n).padStart(2, '0')

/** Format epoch millis the way NJ Transit's board does: M/D/YYYY h:mm:ss AM. */
function njtStamp(epoch) {
  const t = nyNow(epoch)
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12
  const mer = t.hour < 12 ? 'AM' : 'PM'
  return `${t.month}/${t.day}/${t.year} ${h12}:${pad(t.minute)}:${pad(t.second)} ${mer}`
}

// A stable pseudo-random value per (route, trip) so the board doesn't reshuffle
// on every poll — delays persist the way real ones do.
function jitter(seed) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000) / 1000
}

/**
 * Build a plausible ~90 minutes of departures.
 * Trips are anchored to absolute clock slots, so the same trip keeps the same
 * scheduled time across polls and only the countdown moves.
 */
export function sampleBusDV({ route } = {}) {
  const now = Date.now()
  const routes = route
    ? PABT_ROUTES.filter((r) => r.route === String(route).trim())
    : PABT_ROUTES

  const trips = []

  for (const r of routes) {
    const slot = r.headwayMin * 60_000
    // First slot at or after "a couple of minutes ago", so there's always a
    // departure imminent enough to be interesting.
    const first = Math.ceil((now - 2 * 60_000) / slot) * slot

    for (let i = 0; i < 4; i++) {
      const scheduled = first + i * slot
      if (scheduled > now + 95 * 60_000) break

      const seed = `${r.route}:${scheduled}`
      const j = jitter(seed)

      // ~55% of trips are tracked; tracked trips can run 1–6 min late.
      const tracked = j > 0.45
      const delayMin = tracked ? Math.round((j - 0.45) * 11) : 0
      const predicted = scheduled + delayMin * 60_000

      trips.push({
        public_route: r.route,
        header: r.dest,
        lanegate: r.gate,
        sched_dep_time: njtStamp(scheduled),
        departuretime: njtStamp(predicted),
        internal_trip_number: `S${r.route}-${scheduled}`,
        vehicle_id: tracked ? String(5800 + Math.floor(j * 400)) : '',
        passload: tracked ? ['1', '2', '3'][Math.floor(j * 3) % 3] : '',
        remarks: delayMin >= 5 ? 'Running late' : '',
        timing_point_id: '',
        message: '',
        fullscreen: '',
      })
    }
  }

  trips.sort(
    (a, b) => Date.parse(a.departuretime) - Date.parse(b.departuretime),
  )

  return {
    message: { message: '' },
    DVTrip: trips,
  }
}
