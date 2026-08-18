import { useEffect, useState } from 'preact/hooks'

import { hrefFor } from '../lib/routing'

export interface RouteInfo {
  route: string
  destinations: string[]
  weekdayTrips: number
  firstDeparture: string | null
  lastDeparture: string | null
}

interface Props {
  stopName: string
  onNavigate: (href: string) => void
}

/**
 * Every route out of the terminal, one link each.
 *
 * This is the page that makes the other 68 reachable — for a rider who doesn't
 * know their route number yet, and for a crawler, which has no other way in
 * since the board's filter chips are buttons over live data.
 *
 * The schedule figures come from NJ Transit's published GTFS feed rather than
 * the live API, so this page is just as true at 4am as at rush hour.
 */
export function RouteIndex({ stopName, onNavigate }: Props) {
  const [routes, setRoutes] = useState<RouteInfo[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    fetch('/routes.json', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('routes'))))
      .then((d) => setRoutes(d.routes as RouteInfo[]))
      .catch(() => setFailed(true))
  }, [])

  return (
    <section class="index">
      <h1 class="index__title">NJ TRANSIT bus routes from {stopName}</h1>
      <p class="index__lede">
        {routes ? routes.length : 68} bus routes leave {stopName}. Pick one for live departure times
        and the gate it boards at.
      </p>

      {failed && <p class="index__lede">Route list unavailable — the live board still works.</p>}

      <ul class="index__grid">
        {(routes ?? []).map((r) => (
          <li key={r.route}>
            <a
              class="rcard"
              href={hrefFor([r.route])}
              onClick={(e: MouseEvent) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                e.preventDefault()
                onNavigate(hrefFor([r.route]))
              }}
            >
              <span class="rcard__num">{r.route}</span>
              <span class="rcard__to">{r.destinations[0] ?? 'New Jersey'}</span>
              {r.firstDeparture && r.lastDeparture && (
                <span class="rcard__hours">
                  {r.firstDeparture} – {r.lastDeparture}
                </span>
              )}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
