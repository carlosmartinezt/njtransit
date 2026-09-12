// GET /api/departures?stop=&route=&direction=
//
// The board. Everything else in this app exists to make this one response
// correct.

import { buildBoard, defaultStopId } from '../server/board.mjs'
import { handler, clientIp, query, send, validStopId } from '../server/http.mjs'

export default handler(async (req, res) => {
  const params = query(req)
  const stopId = (params.get('stop') || defaultStopId()).trim()
  const route = params.get('route')?.trim() || undefined
  const direction = params.get('direction')?.trim() || undefined

  if (!validStopId(stopId)) return send(res, 400, { error: 'Invalid stop id' })

  const board = await buildBoard({ stopId, route, direction, ip: clientIp(req) })

  // The CDN is what replaces the single always-warm process: twenty seconds of
  // shared cache means a rush-hour crowd on one stop costs three upstream calls
  // a minute, not three hundred. The browser revalidates every time, so a phone
  // never shows a board the CDN has already replaced, and the UI dates every
  // board from `generatedAt` — so a stale-while-revalidate copy says how old it
  // is rather than pretending to be live.
  send(res, 200, board, {
    'Cache-Control': 'public, max-age=0, s-maxage=20, stale-while-revalidate=60',
  })
})
