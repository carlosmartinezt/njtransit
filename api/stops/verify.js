// GET /api/stops/verify — checks the seeded DepartureVision stop ids against
// the live API. Needs credentials; reports per-stop rather than failing whole.

import { njtClient, spendCall } from '../../server/board.mjs'
import { normalizeDepartures } from '../../server/njt.mjs'
import { allStops } from '../../server/stops.mjs'
import { handler, clientIp, send } from '../../server/http.mjs'

export default handler(async (req, res) => {
  const client = njtClient()
  if (!client) {
    return send(res, 503, {
      error: 'No NJ Transit credentials configured, so stop IDs cannot be verified.',
    })
  }

  const results = []
  for (const stop of allStops().filter((s) => s.terminal)) {
    try {
      await spendCall()
      const payload = await client.getBusDV({ stop: stop.id, ip: clientIp(req) })
      const { departures, notice } = normalizeDepartures(payload)
      results.push({
        id: stop.id,
        name: stop.name,
        ok: departures.length > 0,
        departures: departures.length,
        sampleRoutes: [...new Set(departures.map((d) => d.route))].slice(0, 6),
        notice,
      })
    } catch (err) {
      results.push({ id: stop.id, name: stop.name, ok: false, error: err.message })
    }
  }
  send(res, 200, { results })
})
