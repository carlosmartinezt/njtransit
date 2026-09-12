// GET /api/health — source, budget, and whether state is actually persisting.

import { callsToday, dailyCallCap, defaultStopId, isLive } from '../server/board.mjs'
import { gateHistoryStats, loadSummaryGateIndex } from '../server/gates.mjs'
import { storeKind } from '../server/store.mjs'
import { handler, send } from '../server/http.mjs'

export default handler(async (req, res) => {
  const stopId = defaultStopId()
  // Only the service/route fallbacks: health is pinged by deploys and uptime
  // checks, and the whole history is a few hundred KB. /api/gates shows it all.
  const index = await loadSummaryGateIndex(stopId)

  send(res, 200, {
    ok: true,
    source: isLive() ? 'live' : 'sample',
    store: storeKind(),
    // An in-memory store on a serverless deploy means gate history is being
    // thrown away on every cold start. Say so here rather than in a log nobody
    // reads.
    persistent: storeKind() === 'redis',
    upstreamCallsToday: await callsToday(),
    dailyCallCap: dailyCallCap(),
    defaultStopId: stopId,
    gateHistory: { ...gateHistoryStats(index), scope: 'service and route keys only' },
    region: process.env.VERCEL_REGION ?? null,
    deployment: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  })
})
