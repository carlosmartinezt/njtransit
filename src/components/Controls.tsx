import type { SortMode } from '../lib/types'

interface Props {
  sort: SortMode
  onSort: (mode: SortMode) => void
  routes: string[]
  pinnedRoutes: string[]
  onTogglePin: (route: string) => void
  onClearPins: () => void
}

/**
 * Sort control plus route filter.
 *
 * Tapping a route filters to it; the same tap remembers it, so the rider's own
 * routes come back next time without a settings screen.
 */
export function Controls({
  sort,
  onSort,
  routes,
  pinnedRoutes,
  onTogglePin,
  onClearPins,
}: Props) {
  const pinned = new Set(pinnedRoutes)

  return (
    <>
      <div class="controls">
        <div class="seg" role="group" aria-label="Sort departures">
          <button
            type="button"
            class="seg__btn"
            aria-pressed={sort === 'time'}
            onClick={() => onSort('time')}
          >
            By time
          </button>
          <button
            type="button"
            class="seg__btn"
            aria-pressed={sort === 'route'}
            onClick={() => onSort('route')}
          >
            By route
          </button>
        </div>

        <div class="controls__spacer" />

        {pinned.size > 0 && (
          <button type="button" class="linkish" onClick={onClearPins}>
            Show all
          </button>
        )}
      </div>

      {routes.length > 1 && (
        <div class="chips" role="group" aria-label="Filter by route">
          {routes.map((r) => (
            <button
              key={r}
              type="button"
              class="chip"
              aria-pressed={pinned.has(r)}
              onClick={() => onTogglePin(r)}
            >
              {r}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
