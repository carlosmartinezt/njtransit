// GET /api/gates?stop= — what the board has learned, and the evidence for every
// "usually gate N" it shows.

import { defaultStopId } from '../server/board.mjs'
import { gateHistoryEntries, gateHistoryStats, loadFullGateIndex } from '../server/gates.mjs'
import { handler, query, send, validStopId } from '../server/http.mjs'

export default handler(async (req, res) => {
  const stopId = (query(req).get('stop') || defaultStopId()).trim()
  if (!validStopId(stopId)) return send(res, 400, { error: 'Invalid stop id' })

  const index = await loadFullGateIndex(stopId)
  send(res, 200, {
    stop: stopId,
    ...gateHistoryStats(index),
    entries: gateHistoryEntries(index),
  })
})
