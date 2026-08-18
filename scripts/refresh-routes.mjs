// Build data/routes.json — the routes that actually serve Port Authority.
//
// The route landing pages are static HTML generated at build time, so their
// content can't come from the live API: it has to be something true whether or
// not a bus is running right now. NJ Transit's published GTFS feed has exactly
// that — the scheduled service behind each route.
//
//   curl -Lo /tmp/bus_data.zip https://www.njtransit.com/bus_data.zip
//   unzip -d /tmp/gtfs /tmp/bus_data.zip
//   node scripts/refresh-routes.mjs /tmp/gtfs
//
// The output is small and committed, so a build never needs the 49MB feed.
// Re-run it when NJ Transit publishes a new pick (a few times a year).

import { createReadStream, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'data', 'routes.json')

const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/refresh-routes.mjs <unzipped-gtfs-dir>')
  process.exit(1)
}

// Every GTFS stop_id the terminal goes by. NJ Transit lists Port Authority
// several times over — the terminal itself, the drop-off, and a few bays — and
// a route counts as serving it if it touches any of them.
const PABT_STOP_IDS = new Set(['3511', '43260', '43274', '43310', '43314'])

/** The DepartureVision stop this app calls Port Authority. */
const PABT_STOP_CODE = '26229'

function splitCsvLine(line) {
  const out = []
  let field = ''
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
      continue
    }
    if (c === '"') quoted = true
    else if (c === ',') {
      out.push(field)
      field = ''
    } else field += c
  }
  out.push(field)
  return out
}

/** Stream a GTFS table so stop_times.txt (74MB) never lands in memory. */
async function readRows(file, onRow) {
  const path = join(src, file)
  if (!existsSync(path)) throw new Error(`missing ${file} in ${src}`)

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  let header = null

  for await (const line of rl) {
    if (!line.trim()) continue
    const cells = splitCsvLine(line)
    if (!header) {
      header = cells.map((h) => h.replace(/^﻿/, '').trim())
      continue
    }
    const row = {}
    header.forEach((h, i) => (row[h] = cells[i] ?? ''))
    onRow(row)
  }
}

/** "24:35:00" is GTFS for 12:35am the next day; keep the ordering, fix the label. */
function clockLabel(hhmmss) {
  const [h, m] = hhmmss.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  const hour = h % 24
  const suffix = hour < 12 ? 'AM' : 'PM'
  const display = hour % 12 === 0 ? 12 : hour % 12
  return `${display}:${String(m).padStart(2, '0')} ${suffix}`
}

console.log('▶ calendar…')
// NJ Transit ships no calendar.txt — every service is spelled out date by date
// in calendar_dates.txt. A service counts as weekday service when none of its
// active dates lands on a weekend, which cleanly separates the Saturday and
// Sunday picks from the four weekday variants.
const serviceDays = new Map()
await readRows('calendar_dates.txt', (r) => {
  if (r.exception_type !== '1') return
  const y = Number(r.date.slice(0, 4))
  const m = Number(r.date.slice(4, 6))
  const d = Number(r.date.slice(6, 8))
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay()

  let set = serviceDays.get(r.service_id)
  if (!set) serviceDays.set(r.service_id, (set = new Set()))
  set.add(day)
})

const weekdayServices = new Set()
for (const [id, days] of serviceDays) {
  if (days.size > 0 && ![...days].some((d) => d === 0 || d === 6)) weekdayServices.add(id)
}
console.log(`  ${weekdayServices.size} weekday service ids of ${serviceDays.size}`)

console.log('▶ stop_times (the big one)…')
// Half the trips at Port Authority are arriving, not leaving — their headsign
// reads "NEW YORK" and their time is when they pull in. A departure board cares
// about the other half, so keep a trip only when Port Authority isn't its last
// stop. That needs the final stop_sequence, hence two things tracked per trip.
const pabtStop = new Map()
const lastSeq = new Map()
await readRows('stop_times.txt', (r) => {
  const seq = Number(r.stop_sequence)
  if (seq > (lastSeq.get(r.trip_id) ?? -1)) lastSeq.set(r.trip_id, seq)

  if (!PABT_STOP_IDS.has(r.stop_id)) return
  const [h, m] = r.departure_time.split(':').map(Number)
  if (Number.isFinite(h)) {
    pabtStop.set(r.trip_id, { secs: h * 3600 + m * 60, raw: r.departure_time, seq })
  }
})

const pabtDeparture = new Map()
for (const [tripId, stop] of pabtStop) {
  if (stop.seq < (lastSeq.get(tripId) ?? stop.seq)) pabtDeparture.set(tripId, stop)
}
console.log(`  ${pabtDeparture.size} trips depart Port Authority (of ${pabtStop.size} touching it)`)

console.log('▶ trips…')
const byRoute = new Map()
await readRows('trips.txt', (r) => {
  const dep = pabtDeparture.get(r.trip_id)
  if (!dep) return

  let e = byRoute.get(r.route_id)
  if (!e) {
    e = { trips: 0, weekdayTrips: 0, first: null, last: null, headsigns: new Map() }
    byRoute.set(r.route_id, e)
  }

  e.trips++
  const weekday = weekdayServices.has(r.service_id)
  if (weekday) {
    e.weekdayTrips++
    if (!e.first || dep.secs < e.first.secs) e.first = dep
    if (!e.last || dep.secs > e.last.secs) e.last = dep
  }

  // Headsigns carry "-Exact Fare" and similar operational notes riders don't
  // need; the destination is everything before the dash.
  const head = (r.trip_headsign || '').split('-Exact')[0].trim()
  if (head) e.headsigns.set(head, (e.headsigns.get(head) ?? 0) + 1)
})
console.log(`  ${byRoute.size} routes serve Port Authority`)

console.log('▶ routes…')
const meta = new Map()
await readRows('routes.txt', (r) => meta.set(r.route_id, r))

const routes = []
for (const [routeId, e] of byRoute) {
  const m = meta.get(routeId) ?? {}
  const short = (m.route_short_name || routeId).trim()

  // Headsigns lead with the route number the page already shows in large type,
  // then often with how the bus gets there — "166X I-95 EXPRESS BERGENFIELD" is
  // the express running to Bergenfield. A landing page listing the places a
  // route serves wants the place, so the routing drops out here.
  const destinations = [...e.headsigns.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([h]) =>
      h
        .replace(new RegExp(`^${short}[A-Z]{0,2}\\s+`), '')
        .replace(/^(I-\d+\s+)?(TURNPIKE\s+|GARDEN STATE\s+)?(EXPRESS|LOCAL|LTD)\s+/, '')
        .trim(),
    )
    .filter(Boolean)

  routes.push({
    route: short,
    destinations: [...new Set(destinations)].slice(0, 6),
    weekdayTrips: e.weekdayTrips,
    firstDeparture: e.first ? clockLabel(e.first.raw) : null,
    lastDeparture: e.last ? clockLabel(e.last.raw) : null,
  })
}

routes.sort((a, b) => {
  const na = parseInt(a.route, 10)
  const nb = parseInt(b.route, 10)
  if (Number.isNaN(na) || Number.isNaN(nb)) return a.route.localeCompare(b.route)
  return na - nb || a.route.localeCompare(b.route)
})

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(
  OUT,
  JSON.stringify({ stopId: PABT_STOP_CODE, stop: 'Port Authority Bus Terminal', routes }, null, 1) + '\n',
)
console.log(`✓ ${routes.length} routes → ${OUT}`)
