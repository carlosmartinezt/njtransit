import type { Departure } from '../lib/types'
import { clockTime, countdown } from '../lib/time'
import { urgencyOf } from '../lib/board'

interface Props {
  departure: Departure
  now: number
  /** False for repeat rows under a route group header, which already names it. */
  showRoute?: boolean
}

export function BoardRow({ departure: d, now, showRoute = true }: Props) {
  const urgency = urgencyOf(d, now)
  const when = d.statusText ?? countdown(d.departsAt, now)
  const late = d.delayMin != null && d.delayMin >= 2

  return (
    <li class={`row row--${urgency}`}>
      {/* The service, not the family: 166, 166T and 166X can leave within a
          minute of each other from three gates, and showing "166" on all three
          reads as a duplicated row rather than three different buses. */}
      <div class="row__route">
        {showRoute ? d.service : <span class="sr">Route {d.service}</span>}
      </div>

      <div class="row__mid">
        <div class="row__dest">{d.destination || 'Destination not posted'}</div>
        <div class="row__tags">
          {/* Row gates stay outlined even when imminent — the filled plate is
              reserved for the hero, so there is only ever one on screen. */}
          {/* A remembered gate is drawn dashed and prefixed "usually", because
              it is a good bet from previous days, not a posted fact. */}
          {d.gate ? (
            <span class={`gate${d.gateSource === 'usual' ? ' gate--usual' : ''}`}>
              {d.gateSource === 'usual' ? 'Usually ' : 'Gate '}
              {d.gate}
            </span>
          ) : (
            <span class="gate gate--none">No gate</span>
          )}

          {d.isLive && (
            <span class="tag tag--live">
              <span class="tag__dot" aria-hidden="true" />
              Tracked
            </span>
          )}

          {late && <span class="tag tag--late">{d.delayMin} min late</span>}

          {/* Only a full bus changes what a rider does. */}
          {d.load === 'heavy' && <span class="tag">Crowded</span>}
        </div>
      </div>

      <div class="row__when">
        <div class="row__count">{when}</div>
        <div class="row__clock">{clockTime(d.departsAt)}</div>
      </div>
    </li>
  )
}
