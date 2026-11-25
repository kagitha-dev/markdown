# kagitha Markdown Viewer

A free, private Markdown viewer that runs entirely in the browser: **https://markdown.kagitha.com**

Files are opened in your browser and never uploaded. Fonts, the code highlighter and the diagram renderer are bundled with the app, so it makes no third-party requests.

## Features

- **Write and edit Markdown** (CodeMirror 6, loaded the first time you edit). Click **Edit**, press Ctrl/Cmd+Shift+E, or **New** (Ctrl/Cmd+Alt+N) for a blank document.
  - Menu bar: **File** (new, templates, new file in folder, open, save, save as, export), **Edit** (undo, find and replace, go to line, line moves), **Format**, **Paragraph** (paragraph, headings 1–6, heading level up/down, lists, task done, quote, indent), **Insert** (link, link reference, image, footnote, tables, code and math blocks, Mermaid diagram, GitHub alerts, collapsible section, horizontal line, table of contents, front matter, OKF front matter, date), **Table** (rows, columns, alignment, tidy), **View** and **Help** (keyboard shortcuts)
  - Toolbar with a text-style picker and the common formatting buttons
  - Editor and preview side by side (they scroll together; double-click the preview to jump the editor there), editor only, or preview only. On phones the two switch.
  - Lists and quotes continue on Enter; Tab moves between table cells and adds a row at the end; pasting a URL over selected text makes a link
  - Code blocks are highlighted in the editor for the same languages as the preview; front matter is highlighted as YAML
  - **Save** (Ctrl/Cmd+S) writes back to the file in Chrome and Edge, including files in an opened folder; **Save as** (Ctrl/Cmd+Shift+S) picks a place. Other browsers download a copy.
  - Unsaved changes to other files in a folder are kept while you move between files; the browser asks before closing a tab or opening something else over unsaved work
  - New documents are kept in the browser until saved
- GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) render as coloured callouts
- Open a file by drag-and-drop, the **Open** button (Ctrl/Cmd+O) or **Paste** (Ctrl/Cmd+Shift+V)
- **Find in the open file** with the search button or Ctrl/Cmd+F: every match highlighted, a count, Enter / Shift+Enter to step through (also in Source view; a second Ctrl/Cmd+F opens the browser's own search)
- **Open a whole folder** with the **Folder** button (Ctrl/Cmd+Shift+O) or by dropping it on the window. Chrome and Edge use the File System Access API; other browsers use a folder picker.
  - File tree in the side panel; the folder's `index.md` or `README.md` opens first
  - Links between files work (`../other.md#heading`, folder links, links without `.md`), and Back/Forward move between files
  - Images with relative paths are shown from the folder (and embedded in HTML exports)
  - Search across every file (Ctrl/Cmd+K) with MiniSearch, matches highlighted in the page
- **Open Knowledge Format (OKF) bundles**, from a folder or a `.zip` (JSZip). Follows OKF v0.3 (Nov 2026) with the v0.2 fallbacks.
  - Detected from `okf_version` in the root `index.md`, or when most files have a `type`
  - **Contents** tab built from the `index.md` files; bundle title, description and license shown
  - **Checks** tab (validator, Zod): unreadable frontmatter, missing `type`, bad `status`, bad dates, `generated` without `by`, `sources` without `resource`, Attested Computations without `runtime`, reserved file names, `log.md` date headings, broken links and path fields, stale concepts, out-of-date verifications, unverified and deprecated notes. Click a problem to open the file; broken links are highlighted in the page.
  - Status, trust tier and freshness in the frontmatter card; "Linked from" (backlinks) for the open file
  - **Graph** view (Cytoscape.js) of links between files, coloured by `type`, for the whole folder or near the open file
  - **Filters** by type, status, tag, trust tier, freshness and date changed; they apply to the file list, search and the graph
- **Recent files and folders** on the home page, kept in IndexedDB in your browser only. Folders opened in Chrome or Edge can be reopened in one click.
- **Installable app that works offline** (service worker via vite-plugin-pwa). Installed in Chrome or Edge, it can open `.md` files from the desktop.
- GitHub Flavored Markdown: tables, task lists, strikethrough, footnotes, autolinks
- Code highlighting (Shiki, 20+ languages) with copy buttons
- Math with KaTeX (`$inline$`, `$$block$$`)
- Mermaid diagrams (bundled, loaded only when a file contains one)
- YAML frontmatter card, with errors reported by line and an OKF `type` badge
- Outline that follows your scroll position
- Preview, Edit and Source views
- Light, dark and system themes
- **Export menu**
  - PDF via the print dialog (Ctrl/Cmd+P), always light, with link URLs printed and a sensible file name
  - Standalone HTML: one file with fonts, math and diagrams embedded, works offline, follows the reader's light/dark setting
  - Markdown: download the original `.md`
  - Copy as formatted text (for Google Docs, Word or email) or copy the raw Markdown
  - Optional frontmatter table at the top of PDF, HTML and formatted-text exports
- Raw HTML is sanitized, so scripts and `javascript:` links are removed
- The last document and theme are remembered in the browser
- The Markdown pipeline loads separately from the app shell (main bundle about 375 kB instead of 1.1 MB)

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
| `npm run build` | Production build into `dist/` with the service worker (what Vercel runs) |
| `npm run build:single` | One self-contained HTML file in `dist-single/` |

## Project layout

```
public/               og.png (social preview), app icons, robots.txt, sitemap.xml
src/
  App.tsx               toolbar, layout, file and folder loading, history, outline, diagrams, saving, editor menus
  editor.tsx            the CodeMirror editor and its command list (loaded on demand)
  md-commands.ts        Markdown editing commands: headings, lists, tables, blocks, links
  edit-menu.tsx         menu bar, toolbar, keyboard-shortcuts and file-name dialogs
  edit-keys.ts          editor keyboard shortcuts (shared by the keymap and the menus)
  code-languages.ts     languages highlighted inside code blocks in the editor
  markdown.ts           unified pipeline and Shiki setup (loaded on demand)
  frontmatter.ts        YAML frontmatter parsing and word count
  workspace.ts          opened folders: reading, path resolution, image blob URLs
  file-tree.tsx         the folder tree
  find-bar.tsx          find in the open file (CSS Custom Highlight API, <mark> fallback)
  side-panels.tsx       folder panel (contents, files, checks, filters, search), links panel, Recent panel
  search.ts             MiniSearch index
  scan.ts               reads a folder once, then builds the index and the OKF analysis (loaded on demand)
  okf.ts                OKF detection, index.md navigation, links/backlinks and the validator (Zod)
  okf-core.ts           trust tier, staleness and status from one file's frontmatter
  filters.ts            frontmatter filters
  graph-view.tsx        the link graph (Cytoscape.js, loaded on demand)
  zip.ts                opening .zip bundles (JSZip, loaded on demand)
  recent.ts             recent files and folders in IndexedDB
  frontmatter-card.tsx  metadata card and YAML error view
  export.ts             HTML/Markdown export, font inlining, rich-text copy
  export-menu.tsx       the Export dropdown
  sample.ts             the welcome document
  index.css             all styles (Tailwind v4 base + custom)
  katex.css             KaTeX styles trimmed to woff2 fonts
```

## Next

- Export a bundle as a static website
- Share links (needs a backend)
