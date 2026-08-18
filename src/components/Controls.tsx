import { useCallback, useEffect, useRef } from 'preact/hooks'

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
  const strip = useRef<HTMLDivElement | null>(null)

  // The strip scrolls sideways, which a touchscreen does for free and a mouse
  // does not: a trackpad swipe works, a wheel doesn't, and the scrollbar is
  // hidden. Above 1024px the chips wrap instead and this never fires; in a
  // narrow desktop window it turns the wheel a rider actually has into the
  // scroll they're trying to do.
  // Arriving on /bus/166 with 60 routes listed, the filtered one is usually
  // out of sight — off the right edge on a phone, below the fold in the wrapped
  // desktop list. Bring it to the rider rather than making them hunt for the
  // chip that explains what they're looking at.
  useEffect(() => {
    const el = strip.current
    if (!el || pinnedRoutes.length === 0) return
    el.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [pinnedRoutes.join(',')])

  const onWheel = useCallback((e: WheelEvent) => {
    const el = strip.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    e.preventDefault()
    el.scrollLeft += e.deltaY
  }, [])

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
        <div class="chips" role="group" aria-label="Filter by route" ref={strip} onWheel={onWheel}>
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
