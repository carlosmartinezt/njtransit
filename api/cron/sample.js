// Daily cron: sample the terminals, then prune what's gone stale.
//
// On the old box a timer sampled Port Authority every five minutes, so the gate
// history learned the whole service day instead of only the hours riders happen
// to open the app. Vercel's Hobby plan allows a cron at most once a day, so that
// is what this is: a single pass, a handful of upstream calls, and honest about
// what it buys — one sample a day barely teaches the board anything. Learning is
// now driven almost entirely by real traffic, which means off-peak trips stay
// thin until someone loads a board during them.
//
// To get the old behaviour back on a plan that allows it, change the schedule in
// vercel.json to `*/5 * * * *`. Nothing else needs to change.
//
// The pass also prunes: the file-backed store pruned on every write, and doing
// that per request against Redis would be a write round trip for something that
// matters once a season.

import { buildBoard, isLive } from '../../server/board.mjs'
import { pruneGates } from '../../server/gates.mjs'
import { allStops } from '../../server/stops.mjs'
import { handler, send } from '../../server/http.mjs'

/**
 * Vercel signs cron requests with CRON_SECRET when it's set. Without one the
 * endpoint is open, which costs an upstream call per hit, so set it.
 */
function authorized(req) {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  return req.headers.authorization === `Bearer ${secret}`
}

export default handler(async (req, res) => {
  if (!authorized(req)) return send(res, 401, { error: 'Unauthorized' })

  const stops = allStops().filter((s) => s.terminal && s.verified !== false)
  const sampled = []

  for (const stop of stops) {
    try {
      const board = await buildBoard({ stopId: stop.id })
      const pruned = await pruneGates(stop.id)
      sampled.push({
        stop: stop.id,
        departures: board.departures.length,
        gatesFilled: board.gatesFilled,
        pruned,
      })
    } catch (err) {
      // A failed sample is not worth failing the cron over; riders' own requests
      // keep the history fed and the next run is tomorrow.
      sampled.push({ stop: stop.id, error: err.message })
    }
  }

  send(res, 200, { ok: true, source: isLive() ? 'live' : 'sample', sampled })
})
