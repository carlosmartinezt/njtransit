// Shared request/response plumbing for the API functions.
//
// Vercel hands each function a Node req/res, so this is the same shape the
// standalone server used — just split per route instead of one switch.

import { NJTransitError } from './njt.mjs'

/** No-store by default: a board is only as good as its timestamp. */
export function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  })
  res.end(JSON.stringify(body))
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim()
  return req.socket?.remoteAddress ?? ''
}

export function query(req) {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams
}

/** DepartureVision stop ids are short alphanumerics; anything else is a typo or a probe. */
export function validStopId(id) {
  return /^[A-Za-z0-9_-]{1,16}$/.test(id)
}

/**
 * Method guard plus the error shape the client expects: a failed board still
 * answers with `departures: []` so the app can render a board-shaped empty
 * state instead of a raw error.
 */
export function handler(fn) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: 'Method not allowed' })
    }
    try {
      await fn(req, res)
    } catch (err) {
      const status = err instanceof NJTransitError ? err.status : 500
      console.error(`${req.url} failed:`, err)
      send(res, status, { error: err.message ?? 'Unexpected error', departures: [] })
    }
  }
}
