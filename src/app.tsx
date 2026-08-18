import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'

import { NextUp } from './components/NextUp'
import { BoardRow } from './components/BoardRow'
import { Controls } from './components/Controls'
import { StopPicker } from './components/StopPicker'
import { Footer } from './components/Footer'

import { fetchBoard, fetchStops, loadLastBoard, saveLastBoard } from './lib/api'
import { loadPrefs, savePrefs, type Prefs } from './lib/prefs'
import { filterDepartures, routesOf, sortDepartures } from './lib/board'
import { agoLabel } from './lib/time'
import type { Board, Freshness, SortMode, Stop } from './lib/types'

// Matches the server's cache TTL — polling faster only re-reads the same board.
const POLL_MS = 20_000
// Countdown granularity is whole minutes, so the clock only needs a nudge.
const TICK_MS = 5_000
// After this long without a successful fetch, stop calling the board "live".
const STALE_AFTER_MS = 60_000

export function App() {
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs())
  const [stops, setStops] = useState<Stop[]>([])
  const [defaultStopId, setDefaultStopId] = useState('')
  const [board, setBoard] = useState<Board | null>(() => loadLastBoard())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [picking, setPicking] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [now, setNow] = useState(() => Date.now())

  const abortRef = useRef<AbortController | null>(null)

  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      savePrefs(next)
      return next
    })
  }, [])

  // ── data ──────────────────────────────────────────────────────────────────

  const load = useCallback(
    async (stopId: string) => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl

      try {
        const next = await fetchBoard(stopId, ctrl.signal)
        setBoard(next)
        setError(null)
        saveLastBoard(next)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        // A previously loaded board stays on screen; the header says how old it
        // is rather than replacing real departures with an error.
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  // Stop list, once. Falls back to whatever the last board named.
  useEffect(() => {
    let cancelled = false
    fetchStops()
      .then(({ stops: list, defaultStopId: fallback }) => {
        if (cancelled) return
        setStops(list)
        setDefaultStopId(fallback)
        if (!prefs.stopId) update({ stopId: fallback })
      })
      .catch(() => {
        /* Offline cold start — the picker just stays empty. */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stopId = prefs.stopId || board?.stop.id || ''

  // A saved stop id can outlive the stop itself — 26126 was a wrong guess at
  // Port Authority and shipped to real phones. Once the server says it doesn't
  // know the id, drop back to the default rather than polling an empty board
  // forever. Only an id the server actively disowns is discarded, so a stop
  // that is merely quiet is left alone.
  useEffect(() => {
    if (!board || board.stop.known !== false) return
    if (!defaultStopId || defaultStopId === stopId) return
    update({ stopId: defaultStopId, pinnedRoutes: [] })
  }, [board, defaultStopId, stopId, update])

  // Poll while the app is visible and online.
  useEffect(() => {
    if (!stopId) return
    load(stopId)

    const tick = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) load(stopId)
    }
    const id = setInterval(tick, POLL_MS)

    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    const onOnline = () => {
      setOnline(true)
      tick()
    }
    const onOffline = () => setOnline(false)

    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [stopId, load])

  // Clock for the countdowns.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  // ── derived ───────────────────────────────────────────────────────────────

  // Freshness comes from how old the *data* is, not from whether a request
  // succeeded. A service worker answers from cache with a perfectly good HTTP
  // 200, so trusting the fetch (or navigator.onLine) would label a board from
  // an hour ago "Live" — the one lie a departure board must never tell.
  const dataAge = board ? now - board.generatedAt : Infinity
  const freshness: Freshness =
    !online && dataAge > STALE_AFTER_MS
      ? 'offline'
      : dataAge < STALE_AFTER_MS && !error
        ? 'live'
        : 'cached'

  const allRoutes = useMemo(() => routesOf(board?.departures ?? []), [board])

  const visible = useMemo(() => {
    if (!board) return []
    const filtered = filterDepartures(board.departures, {
      pinnedRoutes: prefs.pinnedRoutes,
      onlyPinned: prefs.pinnedRoutes.length > 0,
      now,
    })
    return sortDepartures(filtered, prefs.sort)
  }, [board, prefs.pinnedRoutes, prefs.sort, now])

  // The hero is always the soonest bus the rider can still catch, regardless of
  // how the list below happens to be sorted.
  const next = useMemo(() => {
    const soonestFirst = sortDepartures(visible, 'time')
    return soonestFirst.find((d) => d.departsAt != null) ?? soonestFirst[0] ?? null
  }, [visible])

  const togglePin = useCallback(
    (route: string) => {
      const set = new Set(prefs.pinnedRoutes)
      if (set.has(route)) set.delete(route)
      else set.add(route)
      update({ pinnedRoutes: [...set] })
    },
    [prefs.pinnedRoutes, update],
  )

  const stopName = board?.stop.short ?? board?.stop.name ?? 'Loading'

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <>
      <header class="hdr">
        <div class="hdr__inner">
          <button
            type="button"
            class="hdr__stop"
            onClick={() => setPicking(true)}
            aria-haspopup="dialog"
          >
            <span class="hdr__name">{stopName}</span>
            <span class="hdr__swap">Change</span>
          </button>

          <span class={`pip pip--${freshness}`}>
            <span class="pip__dot" aria-hidden="true" />
            {freshness === 'live'
              ? 'Live'
              : freshness === 'offline'
                ? 'Offline'
                : board
                  ? agoLabel(board.generatedAt, now)
                  : 'Stale'}
          </span>
        </div>
      </header>

      <main class="shell">
        {board?.source === 'sample' && (
          <div class="banner banner--warn">
            <span class="banner__icon" aria-hidden="true">
              ▲
            </span>
            <span>
              <strong>Sample data</strong> — NJ TRANSIT credentials aren't configured yet.
            </span>
          </div>
        )}

        {freshness !== 'live' && board && (
          <div class="banner">
            <span class="banner__icon" aria-hidden="true">
              ◇
            </span>
            <span>
              {freshness === 'offline' ? 'No connection. ' : "Couldn't refresh. "}
              These departures are from <strong>{agoLabel(board.generatedAt, now)}</strong> —
              gates may have changed since.
            </span>
          </div>
        )}

        {board?.notice && (
          <div class="banner">
            <span class="banner__icon" aria-hidden="true">
              ✳
            </span>
            <span>{board.notice}</span>
          </div>
        )}

        {loading && !board ? (
          <BoardSkeleton />
        ) : next ? (
          <>
            <NextUp departure={next} now={now} />

            <Controls
              sort={prefs.sort}
              onSort={(sort: SortMode) => update({ sort })}
              routes={allRoutes}
              pinnedRoutes={prefs.pinnedRoutes}
              onTogglePin={togglePin}
              onClearPins={() => update({ pinnedRoutes: [] })}
            />

            <DepartureList departures={visible} sort={prefs.sort} now={now} />
          </>
        ) : (
          <EmptyState
            error={error}
            filtered={prefs.pinnedRoutes.length > 0 && (board?.departures.length ?? 0) > 0}
            onClearPins={() => update({ pinnedRoutes: [] })}
            onRetry={() => stopId && load(stopId)}
          />
        )}

        <Footer />
      </main>

      {picking && stops.length > 0 && (
        <StopPicker
          stops={stops}
          currentId={stopId}
          onPick={(id) => {
            update({ stopId: id, pinnedRoutes: [] })
            setPicking(false)
            setLoading(true)
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  )
}

function DepartureList({
  departures,
  sort,
  now,
}: {
  departures: import('./lib/types').Departure[]
  sort: SortMode
  now: number
}) {
  if (sort === 'time') {
    return (
      <ul class="board">
        {departures.map((d) => (
          <BoardRow key={d.id} departure={d} now={now} />
        ))}
      </ul>
    )
  }

  // Grouped by route, so scanning for "my bus" is one jump instead of a scan
  // down a mixed list.
  const groups: { route: string; items: typeof departures }[] = []
  for (const d of departures) {
    const last = groups[groups.length - 1]
    if (last && last.route === d.route) last.items.push(d)
    else groups.push({ route: d.route, items: [d] })
  }

  return (
    <ul class="board">
      {groups.map((g) => {
        // Under "Route 166" sit the 166, the 166T and the 166X, leaving minutes
        // apart from different gates. Suppressing the number on repeat rows is
        // right when they really are the same bus over and over, and actively
        // misleading when they aren't — so a group with variants labels each.
        const hasVariants = g.items.some((d) => d.service !== g.route)
        return (
          <li key={g.route}>
            <div class="rowgroup">Route {g.route}</div>
            <ul class="board" style="border-top:none">
              {g.items.map((d, i) => (
                <BoardRow key={d.id} departure={d} now={now} showRoute={hasVariants || i === 0} />
              ))}
            </ul>
          </li>
        )
      })}
    </ul>
  )
}

function EmptyState({
  error,
  filtered,
  onClearPins,
  onRetry,
}: {
  error: string | null
  filtered: boolean
  onClearPins: () => void
  onRetry: () => void
}) {
  if (filtered) {
    return (
      <div class="empty">
        <p class="empty__title">Nothing on those routes</p>
        <p class="empty__body">
          The routes you picked have no departures in the next hour or so.
        </p>
        <button type="button" class="btn" onClick={onClearPins}>
          Show every route
        </button>
      </div>
    )
  }

  return (
    <div class="empty">
      <p class="empty__title">{error ? "Can't reach the board" : 'No departures'}</p>
      <p class="empty__body">
        {error
          ? 'NJ TRANSIT’s feed did not answer. The last board is kept for offline use once one loads.'
          : 'NJ TRANSIT isn’t listing any upcoming buses from this terminal right now.'}
      </p>
      <button type="button" class="btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

function BoardSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span class="sr">Loading departures</span>
      <div class="skel" style="height:132px;margin-top:16px;border-radius:14px" />
      <div class="skel" style="height:38px;margin-top:20px;border-radius:999px;width:190px" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} class="skel" style="height:56px;margin-top:12px" />
      ))}
    </div>
  )
}
