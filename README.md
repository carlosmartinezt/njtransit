# Next Bus — Port Authority

Which bus, which gate, how long.

A single-page departure board for NJ TRANSIT buses, built for the one moment it
exists to serve: standing in Port Authority Bus Terminal, needing to know the
gate before the bus leaves. The gate number is the largest thing on screen
because it's the fact the terminal itself hides.

- **Sorted by time** by default, **sortable by route**, filterable to the routes
  you actually take (tap a route number; it's remembered).
- **Remembers gates.** DepartureVision posts a gate only once the terminal
  assigns one, which is often minutes before boarding. Every gate it does post
  is written down per trip, and a departure that arrives without one is filled
  from history and labelled *Usually gate 224* — dashed, never passed off as
  posted. A slow background poll keeps learning while nobody is looking.
- **Works offline.** The app shell is precached and the last board is kept, shown
  with an explicit "no connection, this is N minutes old" treatment rather than
  passing stale gates off as live.
- **Fast.** ~11 KB of gzipped JS, no framework runtime beyond Preact, fonts
  self-hosted so nothing blocks on the network.
- **Installable.** Add to Home Screen gives a standalone app; the same `dist/`
  wraps directly in Capacitor for iOS/Android later without a rewrite.

## Layout

```
api/          Vercel Functions — the only things holding NJ TRANSIT credentials
  departures.js  the board
  stops.js       stop picker list
  stops/verify.js  checks seeded stop ids against the live API
  gates.js       what the board has learned about gates
  health.js      source, store, budget
  cron/sample.js daily sample + prune
server/       shared modules the functions are thin wrappers over
  board.mjs   board assembly, shared cache, upstream call budget
  njt.mjs     BUSDV2 client: auth, token refresh, response normalization
  gates.mjs   Remembered gates: learn what NJT posts, fill in what it doesn't
  store.mjs   Redis (Upstash), or an in-process fallback for local work
  sample.mjs  Sample board used when credentials aren't configured
  stops.mjs   Stop list (GTFS-derived when available, seed otherwise)
  time.mjs    NJ TRANSIT's timestamps → epoch millis in America/New_York
  dev.mjs     Local API host — runs the api/ handlers without the Vercel CLI
src/          Preact SPA
ops/deploy.sh vercel build + deploy --prebuilt + a health smoke test
scripts/      GTFS stop importer, gate-history importer, screenshot helper
vercel.json   routing, headers, the cron schedule
```

## The NJ TRANSIT API

NJ TRANSIT issues a **username and password**, not an API key. Register at
<https://developer.njtransit.com/registration/>.

The server exchanges them for a token and calls DepartureVision:

```
POST https://pcsdata.njtransit.com/api/BUSDV2/authenticateUser
     x-www-form-urlencoded: username, password
  -> { "Authenticated": "True", "UserToken": "..." }

POST https://pcsdata.njtransit.com/api/BUSDV2/getBusDV
     multipart/form-data: token, stop, direction, route, ip
  -> { "message": {...}, "DVTrip": [ { public_route, header, lanegate,
                                       departuretime, sched_dep_time, ... } ] }
```

`lanegate` is the gate. `header` is the destination. `departuretime` is the
prediction and `sched_dep_time` the timetable — the app shows a bus as *tracked*
only when NJ TRANSIT actually attached a vehicle or a differing prediction.

**Why a server at all:** the credentials can't ship to a browser, and the API
sends no CORS headers. The proxy also caches, which is what keeps usage far
under NJ TRANSIT's published limit of 40,000 calls/day — a 20-second TTL costs
roughly 4,300 calls/day no matter how many devices are polling.

## State

Nothing on Vercel outlives a request, so the three things the old single process
kept in itself now live in Redis (Upstash, via the Vercel Marketplace):

| What | Key | Why it can't be per-instance |
| --- | --- | --- |
| Gate history | `njt:gates:{stop}:…` | It's the product. A per-instance copy would relearn from nothing on every cold start. |
| Board cache | `njt:board:{stop\|route\|dir}` | The 20-second TTL is what bounds upstream calls. Per-instance, the call count multiplies by the number of instances. |
| NJ TRANSIT token | `njt:token` | Otherwise every cold start spends an `authenticateUser` call. |
| Daily call counter | `njt:calls:{date}` | A cap each instance counts separately isn't a cap. |

The gate history is bucketed by stop, day type and departure hour, so a board
reads the hour or two it's actually showing (~25 KB) rather than every gate the
stop has ever posted (~400 KB and growing).

`/api/departures` also carries `s-maxage=20`, so Vercel's CDN answers most
requests without running a function at all. That's safe because the UI dates
every board from `generatedAt`, the moment NJ TRANSIT was actually asked — a
board served from cache says how old it is instead of claiming to be live.

Without Redis configured, all of it falls back to an in-process store: enough to
run locally on a clean checkout, useless in production. `/api/health` reports
`persistent: false` when that's what's happening.

## Setup

```bash
npm install
cp .env.example .env && chmod 600 .env   # add NJT_USERNAME / NJT_PASSWORD
npm run dev                              # web on :5183, api on :3057
```

`npm run dev` runs the `api/` handlers through a small local host
(`server/dev.mjs`), so no Vercel account is needed to work on the app.
`npm run dev:vercel` runs `vercel dev` instead, which applies the real routing,
headers and env from `vercel.json` — worth doing once before a deploy.

Without credentials the app serves a clearly-labelled sample board through the
identical code path, so everything is exercisable before access is granted.

### Confirming the Port Authority stop id

The seeded DepartureVision ids are marked `verified: false` — they're informed
guesses until a live call confirms them. Once credentials are in place:

```bash
curl localhost:3057/api/stops/verify
```

For the authoritative list, download the bus GTFS feed from the developer portal
and import it:

```bash
node scripts/refresh-stops.mjs path/to/stops.txt   # writes data/stops.json
```

Then set `PABT_STOP_ID` in `.env` and restart the API.

## Deploy

```bash
./ops/deploy.sh            # production
./ops/deploy.sh preview    # preview URL
```

It builds locally with `vercel build` and ships the output with `--prebuilt`, so
a broken build fails in seconds instead of halfway through a remote deploy, then
checks `/api/health` on the result and warns if the deployment is serving the
sample board or has no Redis.

### One-time wiring

```bash
npm i -g vercel
vercel link                        # create / attach the project
vercel integration add upstash     # Redis: sets KV_REST_API_URL / KV_REST_API_TOKEN

vercel env add NJT_USERNAME production
vercel env add NJT_PASSWORD production
vercel env add PABT_STOP_ID production      # 26229
vercel env add CRON_SECRET production       # openssl rand -hex 32
```

Then bring the months of learned gates across from the old box, so the first
board on Vercel is as good as the last one on Caddy:

```bash
vercel env pull .env.local
set -a && . ./.env.local && set +a
npm run import:gates                # reads data/gate-history.json
```

**Domain.** `vercel domains add njtransit.carlosmartinezt.com`, then point the
Cloudflare record at Vercel instead of `5.161.231.48`. Vercel issues the
certificate once DNS resolves; the record can stay proxied. The old Caddy site
block and `njtransit-api.service` should come down only after that resolves, and
the systemd unit needs removing by hand:

```bash
systemctl --user disable --now njtransit-api
rm ~/.config/systemd/user/njtransit-api.service
# then delete the njtransit block from /etc/caddy/Caddyfile and reload
```

### The cron caveat

`vercel.json` schedules `/api/cron/sample` once a day, because Vercel's Hobby
plan allows at most one cron run per day. The old box sampled Port Authority
every five minutes, which is what taught the gate history the whole service day
rather than only the hours someone had the app open. One run a day does not
replace that: learning is now driven almost entirely by real traffic, so
off-peak trips stay thin until someone loads a board during them.

On a plan that allows it, change the schedule to `*/5 * * * *` and the old
behaviour is back. Nothing else needs to change.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /api/departures?stop=&route=&direction=` | Normalized board |
| `GET /api/stops?q=` | Stop list for the picker |
| `GET /api/stops/verify` | Checks seeded stop ids against the live API |
| `GET /api/gates?stop=` | What the board has learned, and the evidence for it |
| `GET /api/health` | Source (live/sample), store, upstream calls used today |
| `GET /api/cron/sample` | Daily sample + prune; Vercel calls it, `CRON_SECRET` guards it |

## Notes

Gates change at short notice; the terminal boards are the final word. This is a
personal tool and is not affiliated with or endorsed by NJ TRANSIT. Tickets are
sold only in the official NJ TRANSIT app, which the footer links to.
