const APP_STORE = 'https://apps.apple.com/us/app/nj-transit/id589549928'
const PLAY_STORE = 'https://play.google.com/store/apps/details?id=com.njtransit.njtapp'
const APP_PAGE = 'https://www.njtransit.com/app'

/**
 * Send the rider to the official NJ TRANSIT app, which is the only place that
 * sells tickets. On a phone the store link opens the app if it's installed;
 * everywhere else the app landing page covers both platforms.
 */
function ticketsUrl(): string {
  if (typeof navigator === 'undefined') return APP_PAGE
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/i.test(ua)) return APP_STORE
  if (/Android/i.test(ua)) return PLAY_STORE
  return APP_PAGE
}

export function Footer() {
  return (
    <footer class="foot">
      <a class="btn btn--amber" href={ticketsUrl()} target="_blank" rel="noopener noreferrer">
        Buy tickets in the NJ TRANSIT app
      </a>

      <p class="foot__note">
        Departures come from NJ TRANSIT's DepartureVision feed. Gates can change at short
        notice — the boards in the terminal are the final word. This is a personal tool and
        is not affiliated with or endorsed by NJ TRANSIT.
      </p>
    </footer>
  )
}
