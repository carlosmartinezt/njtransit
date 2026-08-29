import type { Departure } from '../lib/types'
import { clockTime, countdown, minutesUntil } from '../lib/time'

interface Props {
  departure: Departure
  now: number
}

/**
 * The hero: the one bus the rider is most likely to be running for.
 *
 * Gate comes first and largest, because that's the fact the terminal itself
 * hides — the route number is already on the ticket, the gate isn't.
 */
export function NextUp({ departure, now }: Props) {
  const min = minutesUntil(departure.departsAt, now)
  const imminent = min != null && min <= 3
  const when = departure.statusText ?? countdown(departure.departsAt, now)
  const usual = departure.gateSource === 'usual'

  return (
    <section class="next" aria-labelledby="next-label">
      <p class="next__label" id="next-label">
        Next departure
      </p>

      <div class="next__body">
        {departure.gate ? (
          /* The plate carries the same number either way, but a remembered gate
             says so on the label — a rider who walks to 224 and finds it empty
             needs to know the terminal never posted it. */
          <div class={`plate${usual ? ' plate--usual' : ''}`}>
            <span class="plate__label">{usual ? 'Usually gate' : 'Gate'}</span>
            <span class="plate__value">{departure.gate}</span>
          </div>
        ) : (
          <div class="plate plate--none">
            <span class="plate__label">Gate</span>
            <span class="plate__value">Not posted</span>
          </div>
        )}

        <div class="next__meta">
          <div class={`next__when${imminent ? ' next__when--now' : ''}`}>{when}</div>

          <div class="next__route">
            <span class="next__num">{departure.service}</span>
            <span class="next__dest">{departure.destination || 'Destination not posted'}</span>
          </div>

          <div class="next__sub">
            {clockTime(departure.departsAt)}
            {departure.delayMin != null && departure.delayMin > 0
              ? ` · ${departure.delayMin} min late`
              : ''}
            {departure.isLive ? ' · tracked' : ' · scheduled'}
          </div>

          {usual && (
            <p class="next__hedge">
              Gate not posted yet — this is where it has left from
              {departure.gateBasis === 'trip' ? ' at this time' : ''} on recent days.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
