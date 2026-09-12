// GET /api/stops?q= — the stop picker's list.

import { defaultStopId } from '../server/board.mjs'
import { searchStops } from '../server/stops.mjs'
import { handler, query, send } from '../server/http.mjs'

export default handler(async (req, res) => {
  send(
    res,
    200,
    { defaultStopId: defaultStopId(), stops: searchStops(query(req).get('q') ?? '') },
    // Baked into the deployment, so it can't change without a new one.
    { 'Cache-Control': 'public, max-age=3600, s-maxage=86400' },
  )
})
