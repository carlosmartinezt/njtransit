// Turn the built SPA into 70 static pages.
//
// A search engine looking for "NJ Transit bus 166" has to find a page that says
// so in HTML, before any JavaScript runs. This takes the shell Vite produced and
// stamps out one real file per route — same bundle, same hashed assets, but its
// own <title>, description, canonical link, structured data and body copy.
//
// The copy isn't filler: first and last departure, how many buses run on a
// weekday, and where the route actually goes all come from NJ Transit's
// published GTFS feed via `npm run routes`. Live times can't be baked in, so
// the static page describes the service and the app fills in the board.
//
// Runs as part of `npm run build`. See ops/deploy.sh.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pageMeta, SITE_NAME } from '../src/lib/seo.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DIST = join(ROOT, 'dist')

const ORIGIN = process.env.SITE_ORIGIN ?? 'https://njtransit.carlosmartinezt.com'

const data = JSON.parse(readFileSync(join(ROOT, 'data', 'routes.json'), 'utf8'))
const STOP = data.stop
const ROUTES = data.routes

const shell = readFileSync(join(DIST, 'index.html'), 'utf8')

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Sentence-case a GTFS headsign — "CRESSKILL VIA GRAND AVE" shouts on a page. */
function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Via|And|To|The|At)\b/g, (m) => m.toLowerCase())
}

/**
 * Rewrite the head of Vite's shell.
 *
 * Everything here is per page: two pages sharing a canonical or a description is
 * the fastest way to get both dropped from an index.
 */
function head(html, { title, description, canonical, jsonLd }) {
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(
      /<meta name="description"[^>]*>/,
      [
        `<meta name="description" content="${esc(description)}" />`,
        `<link rel="canonical" href="${esc(canonical)}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="${esc(SITE_NAME)}" />`,
        `<meta property="og:title" content="${esc(title)}" />`,
        `<meta property="og:description" content="${esc(description)}" />`,
        `<meta property="og:url" content="${esc(canonical)}" />`,
        `<meta name="twitter:card" content="summary" />`,
        `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
      ].join('\n    '),
    )
}

/**
 * Static body copy, in a node the app deletes once it has rendered.
 *
 * It can't live inside #app: Preact appends to that container rather than
 * replacing it, so the crawler copy would sit above the live board forever.
 */
function body(html, content) {
  return html.replace(
    '<div id="app"></div>',
    `<div id="app"></div>\n    <div id="static">${content}</div>`,
  )
}

function crumbs(items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: ORIGIN + it.path,
    })),
  }
}

function write(path, html) {
  const dir = join(DIST, path)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), html)
}

// ── route pages ───────────────────────────────────────────────────────────────

for (const r of ROUTES) {
  const meta = pageMeta({ routes: [r.route], index: false }, STOP)
  const canonical = `${ORIGIN}/bus/${r.route}`
  const destinations = r.destinations.map(titleCase)

  const schedule =
    r.firstDeparture && r.lastDeparture
      ? `<p>On a weekday the ${r.route} runs about ${r.weekdayTrips} buses out of ${esc(STOP)}, the first around ${esc(r.firstDeparture)} and the last around ${esc(r.lastDeparture)}.</p>`
      : ''

  write(
    `bus/${r.route}`,
    body(
      head(shell, {
        title: meta.title,
        description: meta.description,
        canonical,
        jsonLd: {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'Service',
              name: `NJ TRANSIT bus route ${r.route}`,
              serviceType: 'Bus route',
              provider: { '@type': 'Organization', name: 'NJ TRANSIT' },
              areaServed: destinations.map((d) => ({ '@type': 'Place', name: d })),
              url: canonical,
            },
            crumbs([
              { name: SITE_NAME, path: '/' },
              { name: 'Bus routes', path: '/routes' },
              { name: `Bus ${r.route}`, path: `/bus/${r.route}` },
            ]),
          ],
        },
      }),
      `<h1>NJ TRANSIT Bus ${esc(r.route)}</h1>
      <p>Live departure times and gate numbers for the ${esc(r.route)} bus from ${esc(STOP)}. Departures come from NJ TRANSIT's DepartureVision feed and refresh every 20 seconds.</p>
      ${destinations.length ? `<p>The ${esc(r.route)} serves ${destinations.map(esc).join(', ')}.</p>` : ''}
      ${schedule}
      <p><a href="/">All departures from ${esc(STOP)}</a> · <a href="/routes">Every bus route</a></p>`,
    ),
  )
}

// ── the route index ───────────────────────────────────────────────────────────

const indexMeta = pageMeta({ routes: [], index: true }, STOP)
write(
  'routes',
  body(
    head(shell, {
      title: indexMeta.title,
      description: indexMeta.description,
      canonical: `${ORIGIN}/routes`,
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'ItemList',
            name: indexMeta.title,
            numberOfItems: ROUTES.length,
            itemListElement: ROUTES.map((r, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              name: `NJ TRANSIT Bus ${r.route}`,
              url: `${ORIGIN}/bus/${r.route}`,
            })),
          },
          crumbs([
            { name: SITE_NAME, path: '/' },
            { name: 'Bus routes', path: '/routes' },
          ]),
        ],
      },
    }),
    `<h1>NJ TRANSIT bus routes from ${esc(STOP)}</h1>
    <p>${ROUTES.length} bus routes leave ${esc(STOP)}. Pick one for live departure times and the gate it boards at.</p>
    <ul>${ROUTES.map(
      (r) =>
        `<li><a href="/bus/${esc(r.route)}">Bus ${esc(r.route)}</a>${
          r.destinations[0] ? ` — ${esc(titleCase(r.destinations[0]))}` : ''
        }</li>`,
    ).join('')}</ul>`,
  ),
)

// ── home ──────────────────────────────────────────────────────────────────────

const homeMeta = pageMeta({ routes: [], index: false }, STOP)
writeFileSync(
  join(DIST, 'index.html'),
  body(
    head(shell, {
      title: homeMeta.title,
      description: homeMeta.description,
      canonical: `${ORIGIN}/`,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: SITE_NAME,
        url: `${ORIGIN}/`,
        description: homeMeta.description,
      },
    }),
    `<h1>Live NJ TRANSIT bus departures from ${esc(STOP)}</h1>
    <p>Which bus, which gate, how long. Departures come from NJ TRANSIT's DepartureVision feed and refresh every 20 seconds.</p>
    <p><a href="/routes">Every bus route from ${esc(STOP)}</a></p>`,
  ),
)

// ── crawler plumbing ──────────────────────────────────────────────────────────

const urls = [
  { loc: `${ORIGIN}/`, priority: '1.0' },
  { loc: `${ORIGIN}/routes`, priority: '0.8' },
  ...ROUTES.map((r) => ({ loc: `${ORIGIN}/bus/${r.route}`, priority: '0.7' })),
]

writeFileSync(
  join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${u.loc}</loc><changefreq>daily</changefreq><priority>${u.priority}</priority></url>`)
    .join('\n')}\n</urlset>\n`,
)

writeFileSync(
  join(DIST, 'robots.txt'),
  `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`,
)

// ── service worker ────────────────────────────────────────────────────────────

// Workbox hashed index.html while building, which was several steps ago —
// before this script rewrote it. The precache is keyed on that hash, so an
// installed phone would go on serving the old page until something else forced
// a change. Restamp the entry with the hash of the file actually shipping.
const swPath = join(DIST, 'sw.js')
const sw = readFileSync(swPath, 'utf8')
const finalIndex = readFileSync(join(DIST, 'index.html'))
const revision = createHash('md5').update(finalIndex).digest('hex')

const entry = /\{url:"index\.html",revision:"([a-f0-9]+)"\}/
const match = entry.exec(sw)
if (!match) {
  // Better to fail the build than to ship a worker that pins a stale page.
  console.error('✗ could not find the index.html precache entry in sw.js')
  process.exit(1)
}
writeFileSync(swPath, sw.replace(entry, `{url:"index.html",revision:"${revision}"}`))

// The /routes page fetches this rather than bundling 19KB of schedule data into
// the board's critical path.
copyFileSync(join(ROOT, 'data', 'routes.json'), join(DIST, 'routes.json'))

console.log(
  `✓ prerendered ${ROUTES.length} route pages + index + home, sitemap, robots (sw index revision ${revision.slice(0, 8)})`,
)
