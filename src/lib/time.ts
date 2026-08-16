const NY_TZ = 'America/New_York'

const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  hour: 'numeric',
  minute: '2-digit',
})

/** Departure clock time, always in terminal-local time. */
export function clockTime(epoch: number | null): string {
  if (epoch == null) return '--:--'
  return clockFmt.format(new Date(epoch))
}

/**
 * Countdown label. Whole minutes only — a rider deciding whether to run does
 * not benefit from seconds, and ticking seconds make the board feel frantic.
 */
export function countdown(epoch: number | null, now: number): string {
  if (epoch == null) return ''
  const min = Math.floor((epoch - now) / 60_000)
  if (min < -1) return 'gone'
  if (min < 1) return 'now'
  if (min === 1) return '1 min'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

export function minutesUntil(epoch: number | null, now: number): number | null {
  if (epoch == null) return null
  return Math.floor((epoch - now) / 60_000)
}

/** "just now" / "2 min ago" — how old the board on screen is. */
export function agoLabel(epoch: number, now: number): string {
  const sec = Math.max(0, Math.round((now - epoch) / 1000))
  if (sec < 45) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  return h === 1 ? '1 hour ago' : `${h} hours ago`
}
