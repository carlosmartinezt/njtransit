// Build data/stops.json from NJ Transit's GTFS bus feed.
//
// The feed is behind the same developer login as the BUSDV2 API. Download the
// bus GTFS zip from https://developer.njtransit.com/, unzip it, then:
//
//   node scripts/refresh-stops.mjs path/to/stops.txt
//
// The generated file replaces the small seed list in server/stops.mjs, so the
// stop picker covers every stop NJ Transit serves and the Port Authority id
// stops being a guess.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'data', 'stops.json')

const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/refresh-stops.mjs <path-to-stops.txt>')
  process.exit(1)
}

/** Minimal RFC4180 CSV reader — GTFS quotes any field containing a comma. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += c
      }
      continue
    }

    if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') {
      field += c
    }
  }

  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// Terminals worth a one-tap button, matched on the GTFS stop name.
const TERMINAL_PATTERNS = [
  { re: /port authority/i, short: 'Port Authority', city: 'New York, NY' },
  { re: /george washington bridge/i, short: 'GW Bridge', city: 'New York, NY' },
  { re: /newark penn/i, short: 'Newark Penn', city: 'Newark, NJ' },
  { re: /hoboken terminal/i, short: 'Hoboken', city: 'Hoboken, NJ' },
  { re: /journal square/i, short: 'Journal Square', city: 'Jersey City, NJ' },
  { re: /atlantic city bus terminal/i, short: 'Atlantic City', city: 'Atlantic City, NJ' },
]

const rows = parseCsv(readFileSync(src, 'utf8'))
const header = rows.shift()
if (!header) {
  console.error('stops.txt is empty')
  process.exit(1)
}

const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]))
for (const required of ['stop_id', 'stop_name']) {
  if (col[required] === undefined) {
    console.error(`stops.txt is missing a ${required} column`)
    process.exit(1)
  }
}

const stops = rows
  .filter((r) => r[col.stop_id])
  .map((r) => {
    const name = (r[col.stop_name] ?? '').trim()
    const match = TERMINAL_PATTERNS.find((t) => t.re.test(name))
    return {
      id: r[col.stop_id].trim(),
      name,
      short: match?.short ?? name,
      city: match?.city ?? null,
      terminal: Boolean(match),
      // Straight from NJ Transit's own feed, so these ids are authoritative.
      verified: true,
    }
  })

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(stops, null, 2))

const terminals = stops.filter((s) => s.terminal)
console.log(`✓ ${stops.length} stops → ${OUT}`)
console.log(`  ${terminals.length} terminals matched:`)
for (const t of terminals) console.log(`    ${t.id.padEnd(8)} ${t.name}`)

const pabt = terminals.find((t) => /port authority/i.test(t.name))
if (pabt) {
  console.log(`\n  Set PABT_STOP_ID=${pabt.id} in .env, then restart the API.`)
} else {
  console.log('\n  ⚠ No Port Authority stop matched — check the feed and TERMINAL_PATTERNS.')
}
