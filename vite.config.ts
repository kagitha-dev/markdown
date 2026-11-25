import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { VitePWA } from 'vite-plugin-pwa'

// `npm run build` -> normal multi-file build for Vercel, installable and offline (service worker)
// `npm run build:single` -> one self-contained HTML file (used for the live preview), no service worker
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    ...(mode === 'single'
      ? [viteSingleFile()]
      : [
          VitePWA({
            registerType: 'autoUpdate',
            injectRegister: false, // registered in main.tsx, only on the real site
            includeAssets: ['icon.svg', 'apple-touch-icon.png'],
            manifest: {
              id: '/',
              name: 'kagitha Markdown Viewer',
              short_name: 'Markdown',
              description: 'Open Markdown files and folders in your browser. Never uploaded. YAML frontmatter and OKF support.',
              start_url: '/',
              scope: '/',
              display: 'standalone',
              background_color: '#ffffff',
              theme_color: '#ffffff',
              categories: ['productivity', 'developer', 'utilities'],
              icons: [
                { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
                { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
              ],
              // Installed on Chrome or Edge, the app can be chosen to open .md files from the desktop.
              file_handlers: [
                { action: '/', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mdx'] } },
              ],
              launch_handler: { client_mode: 'focus-existing' },
            } as any,
            workbox: {
              // The app, fonts, the Markdown pipeline and highlighting are cached on install.
              // The diagram renderer is large, so its pieces are cached the first time a diagram is shown.
              globPatterns: ['**/*.{js,css,html,woff2,svg,png}'],
              globIgnores: ['og.png', '**/*{Diagram,diagram,elk,cose-bilkent,mermaid,dagre,swimlanes,mindmap,katex-gChunk}*'],
              maximumFileSizeToCacheInBytes: 3_000_000,
              navigateFallback: '/index.html',
              cleanupOutdatedCaches: true,
              runtimeCaching: [
                {
                  urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/assets/'),
                  handler: 'CacheFirst',
                  options: { cacheName: 'kmv-assets', expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 365 } },
                },
              ],
            },
          }),
        ]),
  ],
  // Only lazy-loaded pieces (the diagram renderer's layout engines, the C++ grammar) are larger than this.
  build: mode === 'single' ? { outDir: 'dist-single', assetsInlineLimit: 100_000_000 } : { chunkSizeWarningLimit: 1600 },
}))
