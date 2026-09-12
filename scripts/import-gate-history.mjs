// One-shot: move data/gate-history.json into Redis.
//
// The box has months of learned gates in a file the new deploy can't read. This
// carries them over so the first Vercel board is as good as the last Caddy one,
// instead of starting from nothing and relearning through a season of commutes.
//
//   node scripts/import-gate-history.mjs [path/to/gate-history.json]
//
// Needs KV_REST_API_URL / KV_REST_API_TOKEN in the environment:
//
//   vercel env pull .env.local && set -a && . ./.env.local && set +a
//
// Safe to run twice only if you mean it: counts are written, not added, so a
// second run of the same file leaves the same numbers. A second run of a
// *staler* file would roll observations backwards.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { store, storeKind } from '../server/store.mjs'
import { hashFor } from '../server/gates.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = process.argv[2] ?? join(HERE, '..', 'data', 'gate-history.json')

if (storeKind() !== 'redis') {
  console.error(
    '✗ No Redis configured. Set KV_REST_API_URL and KV_REST_API_TOKEN\n' +
      '  (vercel env pull .env.local, then source it) and run again.',
  )
  process.exit(1)
}

const raw = JSON.parse(readFileSync(FILE, 'utf8'))
if (!raw?.keys || typeof raw.keys !== 'object') {
  console.error(`✗ ${FILE} is not a gate history file (expected a "keys" object).`)
  process.exit(1)
}

// The file put the stop inside every key because it was one file for every
// stop. Redis puts it in the hash name, and buckets trip keys by hour:
//   t|26229|166T|wk|1125  ->  njt:gates:26229:t:wk:18, field t|166T|wk|1125#224#n
const byHash = new Map()
const stops = new Set()

for (const [key, rec] of Object.entries(raw.keys)) {
  const [basis, stopId, ...rest] = key.split('|')
  if (!stopId || !rest.length) continue
  stops.add(stopId)

  const shortKey = [basis, ...rest].join('|')
  const name = hashFor(stopId, shortKey)
  const fields = byHash.get(name) ?? {}
  byHash.set(name, fields)

  for (const [gate, entry] of Object.entries(rec.gates ?? {})) {
    fields[`${shortKey}#${gate}#n`] = String(entry.n ?? 0)
    fields[`${shortKey}#${gate}#t`] = String(entry.last ?? rec.last ?? 0)
  }
}

const s = store()
let written = 0

for (const [name, fields] of byHash) {
  const entries = Object.entries(fields)
  // Chunked so a busy hour bucket doesn't arrive as a single enormous request.
  for (let i = 0; i < entries.length; i += 500) {
    await s.hbump(name, { sets: Object.fromEntries(entries.slice(i, i + 500)) })
  }
  written += entries.length / 2
}

console.log(
  `✓ imported ${written} remembered gates across ${byHash.size} buckets ` +
    `for ${stops.size} stop${stops.size === 1 ? '' : 's'} from ${FILE}`,
)
