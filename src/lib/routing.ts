/**
 * URLs for a one-page app.
 *
 * Someone searching "NJ Transit bus 166" should land on a page about the 166,
 * not on a generic board they then have to filter. So every state the board can
 * be in has an address, and the route-filtered ones use a path a search engine
 * can treat as a page in its own right:
 *
 *   /                    the whole board
 *   /bus/166             one route — the shape that gets indexed
 *   /?routes=166,190     several routes, a rider's own shortlist
 *   /routes              index of every route, so the 68 pages are reachable
 *
 * Only the first of those is worth a crawler's time as a landing page, which is
 * why a shortlist stays a query parameter: it's a personal view, not a page.
 */

/** NJ Transit route designations: 166, 320, and variants like 119B. */
const ROUTE_RE = /^[0-9]{1,3}[A-Za-z]{0,2}$/

export interface View {
  /** Routes the board is filtered to. Empty means everything. */
  routes: string[]
  /** The /routes index rather than a board. */
  index: boolean
}

export const HOME: View = { routes: [], index: false }

function normalize(raw: string): string | null {
  const r = raw.trim().toUpperCase()
  return ROUTE_RE.test(r) ? r : null
}

export function parseView(pathname: string, search: string): View {
  const path = pathname.replace(/\/+$/, '') || '/'

  if (path === '/routes') return { routes: [], index: true }

  const bus = /^\/bus\/([^/]+)$/.exec(path)
  if (bus) {
    const route = normalize(decodeURIComponent(bus[1]))
    return { routes: route ? [route] : [], index: false }
  }

  const param = new URLSearchParams(search).get('routes')
  if (param) {
    const routes = param
      .split(',')
      .map(normalize)
      .filter((r): r is string => r != null)
    return { routes: [...new Set(routes)], index: false }
  }

  return HOME
}

/** The canonical address for a set of pinned routes. */
export function hrefFor(routes: string[]): string {
  if (routes.length === 0) return '/'
  if (routes.length === 1) return `/bus/${encodeURIComponent(routes[0])}`
  return `/?routes=${routes.map(encodeURIComponent).join(',')}`
}

export function sameView(a: View, b: View): boolean {
  return a.index === b.index && a.routes.join(',') === b.routes.join(',')
}

import type { PageMeta } from './seo.mjs'
export type { PageMeta }

/**
 * Titles live in seo.mjs so the prerendered page and the running app can't
 * drift apart. See the note there.
 */
export { pageMeta as metaFor } from './seo.mjs'

/** Push a view into history, leaving the scroll position alone. */
export function go(view: View, { replace = false } = {}): void {
  const href = view.index ? '/routes' : hrefFor(view.routes)
  if (href === location.pathname + location.search) return
  if (replace) history.replaceState(null, '', href)
  else history.pushState(null, '', href)
}

export function applyMeta({ title, description }: PageMeta): void {
  document.title = title
  document.querySelector('meta[name="description"]')?.setAttribute('content', description)

  const canonical = document.querySelector('link[rel="canonical"]')
  if (canonical) canonical.setAttribute('href', location.origin + location.pathname)
}
