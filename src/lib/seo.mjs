// Page titles and descriptions, in plain JS so both sides can use them.
//
// The build prerenders a static page per route and the running app rewrites the
// same tags on client-side navigation. Those two have to agree — a title that
// changes the moment JavaScript boots is the kind of mismatch search engines
// treat as cloaking, and it looks broken in a shared link preview either way.
// One module, imported by routing.ts and by scripts/prerender.mjs, is how they
// stay agreed.

export const SITE_NAME = 'Next Bus'
export const DEFAULT_STOP_NAME = 'Port Authority Bus Terminal'

/**
 * @typedef {{ routes: string[], index: boolean }} View
 * @typedef {{ title: string, description: string }} PageMeta
 */

/**
 * @param {View} view
 * @param {string} stopName
 * @returns {PageMeta}
 */
export function pageMeta(view, stopName) {
  if (view.index) {
    return {
      title: `All NJ TRANSIT bus routes from ${stopName}`,
      description: `Every NJ TRANSIT bus route departing ${stopName}, with live gate numbers and departure times for each.`,
    }
  }

  if (view.routes.length === 1) {
    const route = view.routes[0]
    return {
      title: `NJ TRANSIT Bus ${route} — live departures from ${stopName}`,
      description: `Live departure times and gate numbers for the NJ TRANSIT ${route} bus from ${stopName}, straight from DepartureVision.`,
    }
  }

  if (view.routes.length > 1) {
    return {
      title: `Buses ${view.routes.join(', ')} — departures from ${stopName}`,
      description: `Live departures and gates for the ${view.routes.join(', ')} buses from ${stopName}.`,
    }
  }

  return {
    title: `Next Bus — ${stopName}`,
    description: `Which bus, which gate, how long. Live NJ TRANSIT bus departures from ${stopName}, updated every 20 seconds.`,
  }
}
