import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { VitePWA } from 'vite-plugin-pwa'

const API_PORT = process.env.PORT ?? '3057'

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Next Bus — Port Authority',
        short_name: 'Next Bus',
        description: 'Which bus, which gate, how long.',
        theme_color: '#10151c',
        background_color: '#10151c',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // The board itself. Network first so a connected phone always sees
            // live gates, but a cached copy is kept so the app still renders a
            // board underground / on a dead connection. The UI labels how old
            // that copy is rather than passing it off as live.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/departures'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'departures',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Stop list changes a few times a year at most.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/stops'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'stops',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5183,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
    },
  },
  // `vite preview` is how the prerendered pages get checked before a deploy —
  // it needs the same API proxy, and it serves dist/bus/166/index.html the way
  // Caddy does, so /bus/166 can be verified locally.
  preview: {
    port: 5184,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
})
