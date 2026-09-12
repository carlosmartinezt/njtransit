// The one piece of state a serverless deploy can't keep for itself.
//
// On the old box the gate history was a JSON file and the board cache was a Map
// in a process that never exited. Vercel gives neither: every request may land
// on a cold instance with an empty heap and a read-only disk. So both move to
// Redis (Upstash, via the Vercel Marketplace), which is also what keeps the
// upstream call count flat — a cached board is shared by every instance instead
// of being re-fetched once per cold start.
//
// Without Redis configured this falls back to an in-process Map so `vercel dev`
// and the sample board work on a clean checkout with no accounts attached. The
// fallback is per-instance and evaporates: fine for local work, useless in
// production, and /api/health says which one is live.

import { Redis } from '@upstash/redis'

/**
 * The Upstash Marketplace integration sets KV_REST_API_*; a hand-made Upstash
 * database sets UPSTASH_REDIS_REST_*. Accept either so linking the integration
 * or pasting credentials both just work.
 */
function credentials() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  return url && token ? { url, token } : null
}

function redisStore({ url, token }) {
  const redis = new Redis({ url, token, automaticDeserialization: false })

  return {
    kind: 'redis',

    async get(key) {
      return redis.get(key)
    },

    async set(key, value, { ttlSec } = {}) {
      if (ttlSec) await redis.set(key, value, { ex: Math.ceil(ttlSec) })
      else await redis.set(key, value)
    },

    /** True when this call created the key — the whole basis of "count once". */
    async setIfAbsent(key, value, { ttlSec } = {}) {
      const opts = { nx: true }
      if (ttlSec) opts.ex = Math.ceil(ttlSec)
      return (await redis.set(key, value, opts)) !== null
    },

    async incr(key, { ttlSec } = {}) {
      const n = await redis.incr(key)
      // Only the first increment needs the expiry; re-setting it every call
      // would push the day counter's reset forward forever.
      if (n === 1 && ttlSec) await redis.expire(key, Math.ceil(ttlSec))
      return n
    },

    async hgetall(key) {
      return (await redis.hgetall(key)) ?? {}
    },

    /** Several hashes in one round trip — a board needs four or five. */
    async hgetallMany(keys) {
      if (!keys.length) return []
      const p = redis.pipeline()
      for (const key of keys) p.hgetall(key)
      return (await p.exec()).map((r) => r ?? {})
    },

    /**
     * Counters and timestamps for a batch of observations, in one round trip.
     * HINCRBY rather than read-modify-write: two instances recording the same
     * board must not lose each other's counts.
     */
    async hbump(key, { increments = {}, sets = {} }) {
      const p = redis.pipeline()
      for (const [field, by] of Object.entries(increments)) p.hincrby(key, field, by)
      if (Object.keys(sets).length) p.hset(key, sets)
      await p.exec()
    },

    async hdel(key, fields) {
      if (fields.length) await redis.hdel(key, ...fields)
    },
  }
}

function memoryStore() {
  const kv = new Map() // key -> { value, expiresAt }
  const hashes = new Map() // key -> Map(field -> value)

  const live = (key) => {
    const hit = kv.get(key)
    if (!hit) return null
    if (hit.expiresAt && hit.expiresAt < Date.now()) {
      kv.delete(key)
      return null
    }
    return hit
  }

  const hash = (key) => {
    let h = hashes.get(key)
    if (!h) hashes.set(key, (h = new Map()))
    return h
  }

  return {
    kind: 'memory',

    async get(key) {
      return live(key)?.value ?? null
    },

    async set(key, value, { ttlSec } = {}) {
      kv.set(key, { value, expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : 0 })
    },

    async setIfAbsent(key, value, { ttlSec } = {}) {
      if (live(key)) return false
      kv.set(key, { value, expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : 0 })
      return true
    },

    async incr(key, { ttlSec } = {}) {
      const hit = live(key)
      const n = Number(hit?.value ?? 0) + 1
      kv.set(key, {
        value: String(n),
        expiresAt: hit?.expiresAt || (ttlSec ? Date.now() + ttlSec * 1000 : 0),
      })
      return n
    },

    async hgetall(key) {
      return Object.fromEntries(hash(key))
    },

    async hgetallMany(keys) {
      return keys.map((key) => Object.fromEntries(hash(key)))
    },

    async hbump(key, { increments = {}, sets = {} }) {
      const h = hash(key)
      for (const [field, by] of Object.entries(increments)) {
        h.set(field, String(Number(h.get(field) ?? 0) + by))
      }
      for (const [field, value] of Object.entries(sets)) h.set(field, String(value))
    },

    async hdel(key, fields) {
      const h = hash(key)
      for (const f of fields) h.delete(f)
    },
  }
}

let instance = null

/** The process-wide store. Built once per instance, reused across requests. */
export function store() {
  if (!instance) {
    const creds = credentials()
    instance = creds ? redisStore(creds) : memoryStore()
    if (!creds) {
      console.warn(
        '⚠ No Redis configured (KV_REST_API_URL / KV_REST_API_TOKEN) — using an ' +
          'in-memory store. Gate history will not survive this instance.',
      )
    }
  }
  return instance
}

export function storeKind() {
  return store().kind
}
