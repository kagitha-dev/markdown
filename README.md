# kagitha Markdown Viewer

A free, private Markdown viewer that runs entirely in the browser: **https://markdown.kagitha.com**

Files are opened in your browser and never uploaded. Fonts, the code highlighter and the diagram renderer are bundled with the app, so it makes no third-party requests.

## Features (v1)

- Open a file by drag-and-drop, the **Open** button (Ctrl/Cmd+O) or **Paste** (Ctrl/Cmd+Shift+V)
- GitHub Flavored Markdown: tables, task lists, strikethrough, footnotes, autolinks
- Code highlighting (Shiki, 20+ languages) with copy buttons
- Math with KaTeX (`$inline$`, `$$block$$`)
- Mermaid diagrams (bundled, loaded only when a file contains one)
- YAML frontmatter card, with errors reported by line and an OKF `type` badge
- Outline that follows your scroll position
- Preview and Source views
- Light, dark and system themes
- Print / save as PDF and download as HTML
- Raw HTML is sanitized, so scripts and `javascript:` links are removed
- The last document and theme are remembered in the browser

## Develop

```bash
npm install
npm run dev
```

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel, choose **Add New → Project**, then import the repository.
3. Vercel detects Vite. Build command `npm run build`, output folder `dist` (both already set in `vercel.json`).
4. Deploy. Each push to `main` redeploys, and every pull request gets a preview URL.

Or deploy from the command line: `npm i -g vercel && vercel --prod`.

### Custom domain

1. In the Vercel project, open **Settings → Domains** and add `markdown.kagitha.com` and `md.kagitha.com`.
2. At your DNS provider, add a CNAME record for each: `markdown → cname.vercel-dns.com` and `md → cname.vercel-dns.com`.
3. `vercel.json` already redirects `md.kagitha.com` to `markdown.kagitha.com`. HTTPS is set up automatically.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Local dev server |
| `npm run build` | Production build into `dist/` (what Vercel runs) |
| `npm run build:single` | One self-contained HTML file in `dist-single/` |

## Project layout

```
public/               og.png (social preview), robots.txt, sitemap.xml
src/
  App.tsx               toolbar, layout, file loading, outline, diagrams
  markdown.ts           unified pipeline, frontmatter parsing, Shiki setup
  frontmatter-card.tsx  metadata card and YAML error view
  sample.ts             the welcome document
  index.css             all styles (Tailwind v4 base + custom)
  katex.css             KaTeX styles trimmed to woff2 fonts
```

## Next

- v2: open folders, links between files, search, installable PWA
- v3: OKF bundle validator, graph view, frontmatter filters, open .zip bundles
