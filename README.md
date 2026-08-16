# Next Bus — Port Authority

Which bus, which gate, how long.

A single-page departure board for NJ TRANSIT buses, built for the one moment it
exists to serve: standing in Port Authority Bus Terminal, needing to know the
gate before the bus leaves. The gate number is the largest thing on screen
because it's the fact the terminal itself hides.

- **Sorted by time** by default, **sortable by route**, filterable to the routes
  you actually take (tap a route number; it's remembered).
- **Works offline.** The app shell is precached and the last board is kept, shown
  with an explicit "no connection, this is N minutes old" treatment rather than
  passing stale gates off as live.
- **Fast.** ~11 KB of gzipped JS, no framework runtime beyond Preact, fonts
  self-hosted so nothing blocks on the network.
- **Installable.** Add to Home Screen gives a standalone app; the same `dist/`
  wraps directly in Capacitor for iOS/Android later without a rewrite.

## Layout

```
server/       API proxy — the only thing holding NJ TRANSIT credentials
  njt.mjs     BUSDV2 client: auth, token refresh, response normalization
  sample.mjs  Sample board used when credentials aren't configured
  stops.mjs   Stop list (GTFS-derived when available, seed otherwise)
  time.mjs    NJ TRANSIT's timestamps → epoch millis in America/New_York
src/          Preact SPA
deploy/       Caddy site block + systemd user unit
ops/deploy.sh Build + restart + reload
scripts/      GTFS stop importer, screenshot helper
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

## Setup

```bash
npm install
cp .env.example .env && chmod 600 .env   # add NJT_USERNAME / NJT_PASSWORD
npm run dev                              # web on :5183, api on :3057
```

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
./ops/deploy.sh
```

Caddy serves `dist/` directly, so a build is the deploy. The script also
restarts the API user service and reloads Caddy.

One-time wiring:

1. **DNS** — there is no `*.carlosmartinezt.com` wildcard; each subdomain has
   its own Cloudflare record. Add `njtransit` the same way `journal` is set up
   (proxied, → `5.161.231.48`).
2. **Caddy** —
   ```bash
   sudo sh -c 'cat /home/carlos/njtransit/deploy/njtransit.Caddyfile >> /etc/caddy/Caddyfile'
   sudo systemctl reload caddy
   ```

The API runs as a systemd **user** unit (no sudo; lingering keeps it up across
reboots):

```bash
systemctl --user status njtransit-api
journalctl --user -u njtransit-api -f
```

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /api/departures?stop=&route=&direction=` | Normalized board |
| `GET /api/stops?q=` | Stop list for the picker |
| `GET /api/stops/verify` | Checks seeded stop ids against the live API |
| `GET /api/health` | Source (live/sample), upstream calls used today |

## Notes

Gates change at short notice; the terminal boards are the final word. This is a
personal tool and is not affiliated with or endorsed by NJ TRANSIT. Tickets are
sold only in the official NJ TRANSIT app, which the footer links to.
