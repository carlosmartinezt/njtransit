// NJ Transit reports wall-clock times for the terminal, with no timezone and no
// consistent format. Everything here converts those strings into epoch millis in
// America/New_York so the client can render an honest countdown.

export const NY_TZ = 'America/New_York'

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** Current wall-clock date/time in New York. */
export function nyNow(at = Date.now()) {
  const p = Object.fromEntries(
    partsFmt.formatToParts(new Date(at)).map((x) => [x.type, x.value]),
  )
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    // Intl renders midnight as "24" in some ICU versions.
    hour: +p.hour % 24,
    minute: +p.minute,
    second: +p.second,
  }
}

/**
 * Epoch millis for a New York wall-clock time. Resolves the UTC offset by
 * probing what New York calls a candidate instant, which keeps DST correct
 * without pulling in a timezone library.
 */
export function nyEpoch(year, month, day, hour, minute, second = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  // Two passes settle the hour on DST-transition days.
  let ms = guess
  for (let i = 0; i < 2; i++) {
    const seen = nyNow(ms)
    const seenAsUTC = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute,
      seen.second,
    )
    ms += guess - seenAsUTC
  }
  return ms
}

const HHMM = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?$/
const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?$/

function to24h(hour, meridiem) {
  if (!meridiem) return hour
  const pm = meridiem.toLowerCase() === 'p'
  if (pm) return hour === 12 ? 12 : hour + 12
  return hour === 12 ? 0 : hour
}

/**
 * Parse an NJ Transit departure time into epoch millis.
 *
 * Returns null for the non-time strings the board also uses ("APPROACHING",
 * "DELAYED", "5 min"); callers fall back to showing that text verbatim rather
 * than inventing a time.
 */
export function parseDepartureTime(raw, at = Date.now()) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null

  // Already unambiguous.
  const iso = Date.parse(s)
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(s)) return iso

  let m = MDY.exec(s)
  if (m) {
    const [, mo, d, y, h, mi, sec, mer] = m
    return nyEpoch(+y, +mo, +d, to24h(+h, mer), +mi, sec ? +sec : 0)
  }

  m = HHMM.exec(s)
  if (m) {
    const [, h, mi, sec, mer] = m
    const now = nyNow(at)
    const hour = to24h(+h, mer)
    let ms = nyEpoch(now.year, now.month, now.day, hour, +mi, sec ? +sec : 0)
    // A bare clock time just after midnight belongs to tomorrow, not 23h ago.
    // Anything more than 3h in the past is read as the next occurrence.
    if (ms < at - 3 * 3600_000) ms += 24 * 3600_000
    return ms
  }

  return null
}

/** Minutes until a departure, rounded toward the rider's advantage (floor). */
export function minutesUntil(epoch, at = Date.now()) {
  if (epoch == null) return null
  return Math.floor((epoch - at) / 60_000)
}
