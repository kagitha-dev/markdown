import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { docStats, extractFrontmatter } from './frontmatter'
import { FrontmatterCard } from './frontmatter-card'
import { FolderPanel, RecentPanel } from './side-panels'
import { addRecent, clearRecent, listRecent, removeRecent, touchFolderPath, touchZipPath, type RecentEntry } from './recent'
import type { Scan } from './scan'
import type { OpenOpts } from './side-panels'
import { FileLinksPanel } from './side-panels'
import { GraphView } from './graph-view'
import { activeCount, matches, type Filters } from './filters'
import {
  assetUrl, badName, canPickDirectory, canPickFile, canSaveFiles, createFileIn, createFolder, dirOf, ensurePermission, ensureWrite, fromDirectoryHandle,
  moveAt, removeAt, writeAt,
  fromDroppedEntry, fromFileList, isMarkdownName, pickDirectory, pickOpenFile, pickSaveFile, releaseWorkspace, resolveLink,
  startFile, fileNamed, writeFile, type Workspace,
} from './workspace'
import { SAMPLE, SAMPLE_NAME } from './sample'
import { Icon } from './icons'
import { headOf, render } from './renderer'
import { baseName, buildStandaloneHtml, copyRich, downloadBlob, escapeHtml, metaHtml } from './export'
import { ExportMenu } from './export-menu'
import { FindBar, type FindRequest } from './find-bar'
import type { CursorInfo, EditorApi } from './editor'
import { MenuBar, MoveDialog, NameDialog, ShortcutsDialog, Toolbar, type MenuDef, type MenuItem, type ToolDef } from './edit-menu'
import type { TreeActions } from './file-tree'
import { isMac, KEYS, keyLabel } from './edit-keys'

/** The editor (CodeMirror) is loaded the first time someone edits. */
const Editor = lazy(() => import('./editor'))

type Theme = 'system' | 'light' | 'dark'
type View = 'preview' | 'source' | 'graph' | 'edit'
/** How the editor shares the screen with the preview. */
type Layout = 'write' | 'split' | 'preview'
interface Doc {
  name: string
  text: string
  /** path inside the opened folder */
  path?: string
  /** the file on disk, when the browser can save back to it */
  handle?: FileSystemFileHandle
  /** the text as last opened or saved; null for a new document that was never saved */
  saved?: string | null
  /** made with New and not saved to a file yet */
  isNew?: boolean
}
/** Stands for "saved text unknown" (a document restored from an earlier visit with unsaved changes). */
const UNKNOWN = '\u0000'
const isDirty = (d: Doc) => d.saved !== undefined && d.saved !== d.text && !(d.isNew && !d.text.trim())
const isHomeDoc = (d: Doc) => d.name === SAMPLE_NAME && d.text === SAMPLE && !d.path
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function loadDoc(): Doc {
  const d = store.get<{ name: string; text: string; path?: string; isNew?: boolean; dirty?: boolean } | null>('kmv.doc', null)
  if (!d || typeof d.text !== 'string') return { name: SAMPLE_NAME, text: SAMPLE, saved: SAMPLE }
  return { name: d.name, text: d.text, path: d.path, isNew: d.isNew, saved: d.isNew ? null : d.dirty ? UNKNOWN : d.text }
}
const TEMPLATES: Record<string, { name: string; text: () => string }> = {
  note: { name: 'Untitled.md', text: () => `---\ntitle: "Untitled note"\ndate: ${today()}\ntags: []\n---\n\n# Untitled note\n\n` },
  readme: {
    name: 'README.md',
    text: () => '# Project name\n\nOne or two sentences about what this is and who it is for.\n\n## Getting started\n\n```bash\nnpm install\nnpm run dev\n```\n\n## Usage\n\n## Contributing\n\n## License\n',
  },
  okf: {
    name: 'concept.md',
    text: () => `---\ntype: concept\ntitle: "Untitled concept"\ndescription: One line about what this file explains.\nstatus: draft\ntags: []\ngenerated:\n  by: human:you\n  at: ${today()}\n---\n\n# Untitled concept\n\n`,
  },
}
/** History entries for opened files. depth counts entries since home; ws + path identify a file in a folder. */
interface HistState { kmvFile: true; depth: number; ws?: number; path?: string }

const isLocalUrl = (u: string) => !!u && !u.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//')
const histState = (): HistState | null => { try { return history.state?.kmvFile ? history.state : null } catch { return null } }
interface TocItem { id: string; text: string; level: number }

const MAX_SAVE = 500_000
const isTopWindow = (() => { try { return window.self === window.top } catch { return false } })()

const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* storage unavailable */ } },
}

/* ---------- theme ---------- */
function useResolvedDark(theme: Theme) {
  const [sys, setSys] = useState(() => systemDark())
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => setSys(systemDark())
    mq.addEventListener('change', on)
    const mo = new MutationObserver(on)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { mq.removeEventListener('change', on); mo.disconnect() }
  }, [])
  return theme === 'dark' || (theme === 'system' && sys)
}
function systemDark() {
  const host = document.documentElement.getAttribute('data-theme') // set by some embedding viewers
  if (host === 'dark') return true
  if (host === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/* ---------- mermaid (bundled with the app, loaded only when a document needs it) ---------- */
/** Drawn diagrams by theme and source, so editing doesn't redraw the ones that didn't change. */
const mermaidCache = new Map<string, string>()
let mermaidLoad: Promise<any> | null = null
function loadMermaid(): Promise<any> {
  if (!mermaidLoad)
    mermaidLoad = import('mermaid').then((m) => m.default).catch((e) => { mermaidLoad = null; throw e })
  return mermaidLoad
}
let mermaidSeq = 0
async function renderMermaid(root: HTMLElement, dark: boolean) {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-block'))
  if (!blocks.length) return
  // Diagrams drawn before appear at once, without waiting for the renderer.
  for (const b of blocks) {
    const hit = mermaidCache.get((dark ? 'd' : 'l') + (b.dataset.source ?? ''))
    if (hit) { b.innerHTML = hit; b.removeAttribute('data-error') }
  }
  if (blocks.every((b) => mermaidCache.has((dark ? 'd' : 'l') + (b.dataset.source ?? '')))) return
  let mermaid: any
  try { mermaid = await loadMermaid() } catch (e) {
    blocks.forEach((b) => b.setAttribute('data-error', 'Could not load the diagram renderer: ' + (e as Error).message))
    return
  }
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral',
    fontFamily: 'Inter, system-ui, sans-serif',
  })
  for (const b of blocks) {
    if (!b.isConnected) continue
    const src = b.dataset.source ?? ''
    const key = (dark ? 'd' : 'l') + src
    const hit = mermaidCache.get(key)
    if (hit) { b.innerHTML = hit; b.removeAttribute('data-error'); continue }
    try {
      const { svg } = await mermaid.render('mmd-' + ++mermaidSeq, src)
      if (mermaidCache.size > 200) mermaidCache.clear()
      mermaidCache.set(key, svg)
      if (b.isConnected) { b.innerHTML = svg; b.removeAttribute('data-error') }
    } catch (e) {
      b.setAttribute('data-error', 'Diagram error: ' + String((e as Error)?.message ?? e).split('\n')[0])
      document.getElementById('dmmd-' + mermaidSeq)?.remove()
    }
  }
}

/** Scroll only the reading pane, never the page around it. */
function scrollPaneTo(pane: HTMLElement | null, target: HTMLElement | null, smooth = true) {
  if (!pane || !target) return
  const offset = () => target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 20
  // Long pages skip layout for off-screen parts, so sizes are estimates until they're drawn:
  // jump, let the browser draw, then correct until the target stays put.
  if (pane.querySelector('.prose--big')) {
    let tries = 0, still = 0
    const step = () => {
      const d = offset()
      if (Math.abs(d) < 2) still++
      else { still = 0; pane.scrollTop += d }
      // Stop once it has stayed in place for a few frames (newly drawn parts can still shift it).
      if (still < 4 && tries++ < 30) requestAnimationFrame(step)
    }
    step()
    return
  }
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  pane.scrollTo({ top: offset() + pane.scrollTop, behavior: smooth && !reduce ? 'smooth' : 'auto' })
}

/** The element a #fragment points at (footnotes and raw HTML ids get a user-content- prefix). */
function findAnchor(hash: string): HTMLElement | null {
  let id = hash
  try { id = decodeURIComponent(hash) } catch { /* keep */ }
  return document.getElementById(id) ?? document.getElementById('user-content-' + id)
    ?? (document.querySelector(`.prose [name="${CSS.escape('user-content-' + id)}"]`) as HTMLElement | null)
}

/** Highlight search words in the article and return the first match. */
function markTerms(root: HTMLElement, terms: string[]): HTMLElement | null {
  const words = terms.filter((t) => t.length > 1)
  if (!words.length) return null
  const re = new RegExp(words.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.katex, .mermaid-block, .code-bar, .anchor, mark') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  let first: HTMLElement | null = null
  let count = 0
  for (const node of nodes) {
    const text = node.data
    re.lastIndex = 0
    if (!re.test(text)) continue
    re.lastIndex = 0
    const frag = document.createDocumentFragment()
    let last = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (!m[0]) { re.lastIndex++; continue }
      frag.append(text.slice(last, m.index))
      const mark = document.createElement('mark')
      mark.className = 'hit-mark'
      mark.textContent = m[0]
      frag.append(mark)
      first ??= mark
      last = m.index + m[0].length
      if (++count > 300) break
    }
    frag.append(text.slice(last))
    node.replaceWith(frag)
    if (count > 300) break
  }
  return first
}
function clearMarks(root: HTMLElement) {
  root.querySelectorAll('mark.hit-mark').forEach((m) => m.replaceWith(m.textContent ?? ''))
  root.normalize()
}

/** The link or image in the article that points at `href`, for jumping to a reported broken link. */
function findLink(root: HTMLElement, href: string): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('a[href], [data-local-src], .img-missing'))) {
    const h = el.getAttribute('href') ?? el.getAttribute('data-local-src') ?? el.getAttribute('title')
    if (h === href) return el
  }
  return null
}
function flash(el: HTMLElement | null) {
  if (!el) return null
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
  return el
}

/** Images with relative paths are read from the opened folder; without one, a button offers to open the file's folder. */
function showLocalImages(root: HTMLElement, ws: Workspace | null, docPath: string | undefined, rootFallback: boolean) {
  // Images that were waiting for the file's folder become images again once a folder is open.
  if (ws) root.querySelectorAll<HTMLElement>('[data-ask-folder]').forEach((box) => {
    const img = document.createElement('img')
    img.className = 'local-img'
    img.dataset.localSrc = box.dataset.src ?? ''
    if (box.dataset.alt) img.alt = box.dataset.alt
    box.replaceWith(img)
  })
  root.querySelectorAll<HTMLImageElement>('img[data-local-src]').forEach((img) => {
    const src = img.dataset.localSrc ?? ''
    const file = ws && docPath !== undefined ? resolveLink(ws, docPath, src, rootFallback).file : null
    if (ws && file) {
      assetUrl(ws, file).then((u) => { if (img.isConnected) img.src = u }, () => missing(img, src, 'could not be read'))
    } else if (ws) missing(img, src, 'is not in this folder')
    else missing(img, src, '', true)
  })
}
function missing(img: HTMLImageElement, src: string, why: string, askFolder = false) {
  const box = document.createElement(askFolder ? 'button' : 'span')
  box.className = askFolder ? 'img-missing img-missing--ask' : 'img-missing'
  box.title = askFolder ? `Images are read from the file's folder on your computer. Nothing is uploaded.` : src
  if (askFolder) (box as HTMLButtonElement).type = 'button'
  if (askFolder) Object.assign(box.dataset, { askFolder: '', src, alt: img.alt })
  const label = document.createElement('strong')
  label.textContent = img.alt || src.split('/').pop() || 'Image'
  const note = document.createElement('span')
  note.textContent = askFolder ? src : `${src} ${why}`
  box.append(label, note)
  if (askFolder) {
    const act = document.createElement('em')
    act.textContent = "Show images: open this file's folder"
    box.append(act)
  }
  img.replaceWith(box)
}

function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

/* ---------- App ---------- */
export default function App() {
  const [doc, setDoc] = useState<Doc>(loadDoc)
  const [theme, setTheme] = useState<Theme>(() => store.get<Theme>('kmv.theme', 'system'))
  const [view, setView] = useState<View>('preview')
  const viewRef = useRef(view)
  viewRef.current = view
  const [html, setHtml] = useState('')
  const [srcHtml, setSrcHtml] = useState('')
  /** The text that `html` / `srcHtml` were made from; when it differs from the open file, it's still rendering. */
  const [htmlFor, setHtmlFor] = useState<string | null>(null)
  const [srcFor, setSrcFor] = useState<string | null>(null)
  /** Set while only the first part of a long file is shown. */
  const [peekFor, setPeekFor] = useState<string | null>(null)
  const [showLoader, setShowLoader] = useState(false)
  const htmlForRef = useRef(htmlFor)
  htmlForRef.current = htmlFor
  const [toc, setToc] = useState<TocItem[]>([])
  const [activeId, setActiveId] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [dragging, setDragging] = useState<false | 'open' | 'image'>(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [toast, setToast] = useState<{ msg: string; undo?: Doc } | null>(null)
  const [includeFm, setIncludeFm] = useState(() => store.get<boolean>('kmv.exportFm', true))
  const [busy, setBusy] = useState(false)
  const [ws, setWs] = useState<Workspace | null>(null)
  const [scan, setScan] = useState<Scan | null>(null)
  const [panelKey, setPanelKey] = useState(0)
  const [filters, setFilters] = useState<Filters>({})
  const [indexing, setIndexing] = useState<{ done: number; total: number } | null>(null)
  const [query, setQuery] = useState('')
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const [installPrompt, setInstallPrompt] = useState<any>(null)
  /** The find bar: null when closed; a new request each time it's asked for (focuses it, may carry selected words). */
  const [find, setFind] = useState<FindRequest | null>(null)
  const findOpenRef = useRef(false)
  findOpenRef.current = !!find

  /* ---------- editor state ---------- */
  const [layout, setLayout] = useState<Layout>(() => store.get<Layout>('kmv.editLayout', 'split'))
  const [edSide, setEdSide] = useState(() => store.get<boolean>('kmv.editSide', false))
  const [wrap, setWrap] = useState(() => store.get<boolean>('kmv.wrap', true))
  const [lineNums, setLineNums] = useState(() => store.get<boolean>('kmv.lineNumbers', false))
  const [syncScroll, setSyncScroll] = useState(() => store.get<boolean>('kmv.sync', true))
  useEffect(() => { store.set('kmv.editLayout', layout); store.set('kmv.editSide', edSide); store.set('kmv.wrap', wrap); store.set('kmv.lineNumbers', lineNums); store.set('kmv.sync', syncScroll) }, [layout, edSide, wrap, lineNums, syncScroll])
  const narrow = useMedia('(max-width: 900px)')
  /** Side by side needs room; narrow screens switch between writing and the preview. */
  const lay: Layout = narrow && layout === 'split' ? 'write' : layout
  const layRef = useRef(lay)
  layRef.current = lay
  /** Bumped whenever a different document is shown, so the editor starts over with it. */
  const [docKey, setDocKey] = useState(1)
  const docKeyRef = useRef(1)
  /** The editor stays loaded (hidden) after switching to reading, so its undo history survives. */
  const [edMounted, setEdMounted] = useState(false)
  const edRef = useRef<EditorApi | null>(null)
  const [cursor, setCursor] = useState<CursorInfo | null>(null)
  const [keysOpen, setKeysOpen] = useState(false)
  /** Unsaved changes to other files in the opened folder, by "folder id:path". */
  const draftsRef = useRef(new Map<string, Doc>())
  const [draftCount, setDraftCount] = useState(0)
  useEffect(() => { if (view === 'edit') setEdMounted(true) }, [view])

  const dark = useResolvedDark(theme)
  const articleRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sourceRef = useRef<HTMLDivElement>(null)
  const getFindRoot = useCallback(() => (viewRef.current === 'preview' || viewRef.current === 'edit' ? articleRef.current : viewRef.current === 'source' ? sourceRef.current : null), [])
  const wsRef = useRef(ws)
  wsRef.current = ws
  /** What to do once the next document has rendered: jump to a heading, or highlight search words. */
  const pendingRef = useRef<{ hash?: string; terms?: string[]; href?: string } | null>(null)
  const scanRef = useRef(scan)
  scanRef.current = scan
  /** OKF bundles of v0.2 or earlier may also resolve paths from the bundle root. */
  const rootFallback = () => { const o = scanRef.current?.analysis.okf; return !!o && !(o.version && parseFloat(o.version) >= 0.3) }

  const fm = useMemo(() => extractFrontmatter(doc.text), [doc.text])
  const stats = useMemo(() => docStats(doc.text), [doc.text])
  const lineCount = useMemo(() => doc.text.split('\n').length, [doc.text])
  /** Very long rendered pages skip layout for the parts that are off screen. */
  const bigDoc = (htmlFor?.length ?? 0) > 200_000
  const title = (typeof fm?.data?.title === 'string' && fm.data.title) || doc.name
  const dirty = isDirty(doc)
  /** Views that show the rendered article (the editor shows it next to the source). */
  const showsArticle = view === 'preview' || view === 'edit'

  /* theme class + persistence */
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    store.set('kmv.theme', theme)
  }, [dark, theme])
  /* The open document is kept in the browser (a moment after typing stops), so a reload brings it back. */
  useEffect(() => {
    if (doc.text.length >= MAX_SAVE) return
    const t = setTimeout(() => store.set('kmv.doc', { name: doc.name, text: doc.text, path: doc.path, isNew: doc.isNew, dirty: isDirty(doc) }), 400)
    return () => clearTimeout(t)
  }, [doc])
  useEffect(() => { document.title = `${dirty ? '● ' : ''}${title} · kagitha Markdown Viewer` }, [title, dirty])

  /* Render in a background worker (debounced), so large files don't freeze the page. */
  useEffect(() => {
    let live = true
    const text = doc.text
    // While typing, wait for a short pause; large files wait a little longer.
    const delay = viewRef.current === 'edit' ? (text.length > 200_000 ? 450 : 110) : 40
    const t = setTimeout(async () => {
      // Long files: show the opening part first, then the whole file when it's ready.
      const head = headOf(text)
      if (head) render('peek', head).then((out) => { if (live) { setHtml((cur) => (htmlForRef.current === text ? cur : out)); setPeekFor(text) } }, () => {})
      try {
        const out = await render('preview', text)
        if (live) { setHtml(out); setHtmlFor(text); setPeekFor(null) }
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return
        if (live) { setHtml(`<p class="render-error">Could not render this file: ${escapeHtml(String(e))}</p>`); setHtmlFor(text) }
      }
    }, delay)
    return () => { live = false; clearTimeout(t) }
  }, [doc.text])

  useEffect(() => {
    if (view !== 'source' || srcFor === doc.text) return
    let live = true
    const text = doc.text
    render('source', text).then((h) => { if (live) { setSrcHtml(h); setSrcFor(text) } }, () => {})
    return () => { live = false }
  }, [view, doc.text]) // eslint-disable-line react-hooks/exhaustive-deps

  /* A loading card for files that take a moment; small files render too fast to need one. */
  const partial = showsArticle && htmlFor !== doc.text && peekFor === doc.text
  // While editing, the last preview stays up until the new one is ready.
  const pendingView = view === 'source' ? srcFor !== doc.text : showsArticle && htmlFor !== doc.text && !partial && !(view === 'edit' && html)
  useEffect(() => {
    if (!pendingView) { setShowLoader(false); return }
    const t = setTimeout(() => setShowLoader(true), 180)
    return () => clearTimeout(t)
  }, [pendingView, doc.text])

  /* Long pages: group the article into chunks the browser can skip drawing while they're off screen.
     Runs before the first paint so the initial layout is cheap. */
  useLayoutEffect(() => {
    const el = articleRef.current
    if (!el || !showsArticle || !bigDoc) return
    const kids = Array.from(el.children)
    for (let i = 0; i < kids.length; i += 40) {
      const chunk = document.createElement('div')
      chunk.className = 'cv-chunk'
      kids[i].before(chunk)
      chunk.append(...kids.slice(i, i + 40))
    }
  }, [html, showsArticle, bigDoc])

  /* after the article html changes: TOC, copy buttons, diagrams */
  useEffect(() => {
    const el = articleRef.current
    if (!el || !showsArticle) return
    const hs = Array.from(el.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id]'))
    setToc(hs.map((h) => ({ id: h.id, level: +h.tagName[1], text: (h.textContent ?? '').replace(/#$/, '').trim() })))
    el.querySelectorAll<HTMLElement>('pre.shiki').forEach((pre) => {
      if (pre.parentElement?.classList.contains('code-wrap')) return
      const wrap = document.createElement('div')
      wrap.className = 'code-wrap'
      const lang = [...(pre.querySelector('code')?.classList ?? []), ...pre.classList].find((c) => c.startsWith('language-'))?.slice(9)
      pre.replaceWith(wrap)
      wrap.appendChild(pre)
      const bar = document.createElement('div')
      bar.className = 'code-bar'
      bar.innerHTML = `<span class="code-lang"></span><button type="button" class="code-copy">Copy</button>`
      bar.querySelector('.code-lang')!.textContent = lang && lang !== 'text' ? lang : ''
      wrap.prepend(bar)
    })
    showLocalImages(el, wsRef.current, docRef.current.path, rootFallback())
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending?.href) scrollPaneTo(mainRef.current, flash(findLink(el, pending.href)), false)
    else if (pending?.hash) scrollPaneTo(mainRef.current, findAnchor(pending.hash), false)
    else if (pending?.terms?.length) scrollPaneTo(mainRef.current, markTerms(el, pending.terms), false)
    renderMermaid(el, dark)
    lineEls.current = null
    if (viewRef.current === 'edit') requestAnimationFrame(() => syncRef.current('editor'))
  }, [html, showsArticle]) // eslint-disable-line react-hooks/exhaustive-deps

  /* re-theme diagrams */
  useEffect(() => {
    const el = articleRef.current
    if (!el) return
    el.querySelectorAll<HTMLElement>('.mermaid-block').forEach((b) => { b.innerHTML = '' })
    renderMermaid(el, dark)
  }, [dark])

  /* active heading: the last heading above the top quarter of the reading pane */
  useEffect(() => {
    const root = mainRef.current
    if (!root || !toc.length) return
    let frame = 0
    const heads = toc.map((t) => document.getElementById(t.id))
    const update = () => {
      frame = 0
      const limit = root.getBoundingClientRect().top + root.clientHeight * 0.25
      // Headings are in page order, so a binary search finds the last one above the line.
      let lo = 0, hi = heads.length - 1, found = 0
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if ((heads[mid]?.getBoundingClientRect().top ?? Infinity) <= limit) { found = mid; lo = mid + 1 } else hi = mid - 1
      }
      let current = toc[found].id
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = toc[toc.length - 1].id
      setActiveId(current)
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => { root.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame) }
  }, [toc])

  /* a folder opened for the same text (Show images): fill in the images that were waiting for it */
  useEffect(() => {
    if (ws && doc.path !== undefined && articleRef.current && showsArticle && articleRef.current.querySelector('[data-ask-folder]')) {
      showLocalImages(articleRef.current, ws, doc.path, rootFallback())
    }
  }, [ws, doc.path]) // eslint-disable-line react-hooks/exhaustive-deps

  /* clicks inside the article: copy buttons, in-page links */
  const onArticleClick = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-ask-folder]')) { openFileFolderRef.current(); return }
    const copy = t.closest('.code-copy') as HTMLButtonElement | null
    if (copy) {
      const code = copy.closest('.code-wrap')?.querySelector('pre')?.textContent ?? ''
      navigator.clipboard?.writeText(code).then(
        () => { copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1400) },
        () => { copy.textContent = 'Copy failed' },
      )
      return
    }
    const a = t.closest('a') as HTMLAnchorElement | null
    const href = a?.getAttribute('href') ?? ''
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
    if (href.startsWith('#')) {
      e.preventDefault()
      scrollPaneTo(mainRef.current, findAnchor(href.slice(1)))
    } else if (isLocalUrl(href)) {
      e.preventDefault()
      followLinkRef.current(href)
    }
  }, [])

  /* loading files */
  const docRef = useRef(doc)
  docRef.current = doc
  const isHome = isHomeDoc(doc)
  const lastFileRef = useRef<Doc | null>(isHome ? null : doc)

  /** The open document with the editor's latest text (the editor may not have reported it yet). */
  const liveDoc = useCallback((): Doc => {
    const d = docRef.current
    const t = edRef.current?.getText()
    return t !== undefined && t !== d.text ? { ...d, text: t } : d
  }, [])
  const draftKey = (w: Workspace, path: string) => w.id + ':' + path

  const showDoc = useCallback((next: Doc) => {
    // Unsaved changes to a file in the folder are kept, to come back to.
    const cur = liveDoc()
    const w = wsRef.current
    if (w && cur.path && isDirty(cur) && cur.path !== next.path) {
      draftsRef.current.set(draftKey(w, cur.path), cur)
      setDraftCount(draftsRef.current.size)
    }
    setDoc(next.saved === undefined ? { ...next, saved: next.text } : next)
    docKeyRef.current++
    setDocKey(docKeyRef.current)
    const editing = viewRef.current === 'edit' && !isHomeDoc(next)
    setView(editing ? 'edit' : 'preview')
    if (!editing) setEdMounted(false)
    setDrawer(false)
    mainRef.current?.scrollTo({ top: 0 })
  }, [liveDoc])

  /** Unsaved work that an action would throw away; asks before going ahead. */
  const okToLeave = useCallback((withFolder: boolean) => {
    const cur = liveDoc()
    // A file in the folder is kept as a draft when only the file changes.
    const curCounts = isDirty(cur) && (withFolder || !cur.path || !wsRef.current)
    const n = (curCounts ? 1 : 0) + (withFolder ? draftsRef.current.size : 0)
    if (!n) return true
    const what = n === 1 && curCounts ? `${cur.name} has unsaved changes.` : `${n} files have unsaved changes.`
    // Embedded previews can't show dialogs (confirm would just say no); the Undo message covers them.
    if (!isTopWindow) return true
    try { return window.confirm(`${what} Discard them?`) } catch { return false }
  }, [liveDoc])

  /** Add (or replace) a history entry for a file, so Back and Forward move between files and home. */
  const record = useCallback((next: Doc, mode: 'push' | 'replace') => {
    lastFileRef.current = next
    try {
      const cur = histState()
      const depth = cur?.depth ?? 0
      const st: HistState = { kmvFile: true, depth: Math.max(1, depth), ws: next.path ? wsRef.current?.id : undefined, path: next.path }
      if (cur && mode === 'replace') history.replaceState(st, '')
      else history.pushState({ ...st, depth: depth + 1 }, '')
    } catch { /* history unavailable in some embedded viewers */ }
  }, [])

  /* Opening a file replaces the current file entry, so the browser's Back button returns home. */
  const replaceDoc = useCallback((next: Doc, msg: string) => {
    setToast({ msg, undo: liveDoc() })
    record(next, 'replace')
    showDoc(next)
  }, [record, showDoc, liveDoc])

  const goHome = useCallback((checked = false) => {
    if (isHomeDoc(docRef.current)) {
      mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    if (!checked && !okToLeave(false)) return
    setToast(null)
    try { const st = histState(); if (st) { history.go(-st.depth); return } } catch { /* fall through */ }
    showDoc({ name: SAMPLE_NAME, text: SAMPLE })
  }, [showDoc, okToLeave])

  /** Open a file from the opened folder. */
  const openPath = useCallback(async (path: string, opts: { history?: 'push' | 'replace' | 'none'; hash?: string; terms?: string[]; href?: string; force?: boolean; fresh?: boolean } = {}) => {
    const w = wsRef.current
    const f = w?.files.get(path)
    if (!w || !f) return false
    if (path === docRef.current.path && opts.history !== 'none' && !opts.force && !opts.fresh) {
      setDrawer(false)
      if (viewRef.current !== 'preview' && viewRef.current !== 'edit') { pendingRef.current = { hash: opts.hash, terms: opts.terms, href: opts.href }; setView('preview'); return true }
      if (opts.href && articleRef.current) scrollPaneTo(mainRef.current, flash(findLink(articleRef.current, opts.href)))
      else if (opts.hash) scrollPaneTo(mainRef.current, findAnchor(opts.hash))
      else if (opts.terms?.length && articleRef.current) {
        clearMarks(articleRef.current)
        scrollPaneTo(mainRef.current, markTerms(articleRef.current, opts.terms))
      }
      return true
    }
    let text: string
    const draft = draftsRef.current.get(draftKey(w, path))
    if (draft && !opts.force) {
      draftsRef.current.delete(draftKey(w, path))
      setDraftCount(draftsRef.current.size)
      pendingRef.current = opts.hash || opts.terms || opts.href ? { hash: opts.hash, terms: opts.terms, href: opts.href } : null
      if (opts.history !== 'none') record(draft, opts.history ?? 'push')
      else lastFileRef.current = draft
      showDoc(draft)
      return true
    }
    try {
      const file = await f.get()
      if (file.size > 10_000_000) { setToast({ msg: `${f.name} is over 10 MB, which is too large to preview.` }); return false }
      text = await file.text()
    } catch {
      setToast({ msg: `Could not read ${path}. It may have been moved or deleted.` })
      return false
    }
    const next: Doc = { name: f.name, text, path }
    pendingRef.current = opts.hash || opts.terms || opts.href ? { hash: opts.hash, terms: opts.terms, href: opts.href } : null
    if (opts.history !== 'none') record(next, opts.history ?? 'push')
    else lastFileRef.current = next
    showDoc(next)
    if (w.handle) touchFolderPath(w.handle, path)
    else if (w.source === 'zip') touchZipPath(w.name, path)
    return true
  }, [record, showDoc])

  /** Links between files: resolved against the current file's folder. */
  const followLinkRef = useRef<(href: string) => void>(() => {})
  followLinkRef.current = (href: string) => {
    const w = wsRef.current
    const from = docRef.current.path
    if (!w || from === undefined) {
      setToast({ msg: `To follow links to other files (${href}), open the folder that holds this file.` })
      return
    }
    const hash = href.includes('#') ? href.slice(href.indexOf('#') + 1) : undefined
    const { target, file: f } = resolveLink(w, from, href, rootFallback())
    if (target === null) { setToast({ msg: `${href} is outside the opened folder.` }); return }
    if (!f) { setToast({ msg: `${target || href} isn't in this folder.` }); return }
    if (f.kind === 'md') { openPath(f.path, { hash }); return }
    // Images, PDFs and other files open in a new tab, straight from your disk.
    const win = window.open('', '_blank')
    assetUrl(w, f).then((u) => { if (win) win.location.href = u; else window.open(u, '_blank') }, () => win?.close())
  }

  useEffect(() => {
    // A file restored from the last visit still gets a Back-to-home entry.
    try { if (!isHome && !histState()) history.pushState({ kmvFile: true, depth: 1 } satisfies HistState, '') } catch { /* ignore */ }
    const onPop = (e: PopStateEvent) => {
      const st = e.state as HistState | null
      if (!st?.kmvFile) { pendingRef.current = null; showDoc({ name: SAMPLE_NAME, text: SAMPLE }); return }
      const w = wsRef.current
      if (st.path && w && st.ws === w.id && w.files.has(st.path)) openPath(st.path, { history: 'none' })
      else if (lastFileRef.current) showDoc(lastFileRef.current)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* recent files */
  useEffect(() => { listRecent().then(setRecent) }, [])

  const closeFolder = useCallback(() => {
    const w = wsRef.current
    if (w) releaseWorkspace(w)
    draftsRef.current.clear(); setDraftCount(0)
    setWs(null); setScan(null); setIndexing(null); setQuery(''); setFilters({})
    if (viewRef.current === 'graph') setView('preview')
  }, [])

  const readFile = useCallback(async (f: File | Blob & { name: string }, handle?: FileSystemFileHandle) => {
    if (/\.zip$/i.test(f.name) || f.type === 'application/zip') { openZipRef.current(f); return }
    const isText = isMarkdownName(f.name) || f.type.startsWith('text/')
    if (!isText) { setToast({ msg: `${f.name} isn't a Markdown or text file.` }); return }
    if (f.size > 10_000_000) { setToast({ msg: `${f.name} is over 10 MB, which is too large to preview.` }); return }
    if (!okToLeave(true)) return
    const text = await f.text()
    closeFolder()
    replaceDoc({ name: f.name, text, handle }, `Opened ${f.name}`)
    addRecent({ kind: 'file', name: f.name, text }).then(setRecent)
  }, [replaceDoc, closeFolder, okToLeave])

  /** Open a file; Chrome and Edge remember which file it was, so Save writes back to it. */
  const openFile = useCallback(async () => {
    if (!canPickFile || !isTopWindow) { fileRef.current?.click(); return }
    try {
      const h = await pickOpenFile()
      if (h) readFile(await h.getFile(), h)
    } catch { fileRef.current?.click() }
  }, [readFile])

  /** Show an opened folder: its first file, the file tree, and a search index built in the background. */
  const indexJob = useRef<{ cancelled: boolean } | null>(null)
  /**
   * `reload`: the same folder read again after a file was added or saved into it. Drafts,
   * search words and filters carry over, and there's no "Opened" message.
   */
  const loadWorkspace = useCallback(async (w: Workspace | null, start?: string, zipBlob?: Blob, reload = false) => {
    if (!w) return
    if (!w.docs.length) { setToast({ msg: `There are no Markdown files in ${w.name}.` }); return }
    const old = wsRef.current
    if (!reload && !okToLeave(true)) return
    if (old && old !== w) releaseWorkspace(old)
    if (indexJob.current) indexJob.current.cancelled = true
    // Drafts belong to the old folder id; a reload moves them across, a new folder drops them.
    const moved = new Map<string, Doc>()
    if (reload && old) for (const [k, d] of draftsRef.current) if (k.startsWith(old.id + ':')) moved.set(w.id + k.slice(String(old.id).length), d)
    // Reading the same folder again keeps unsaved changes to the open file, too.
    const live = liveDoc()
    if (reload && live.path && isDirty(live) && w.files.has(live.path)) moved.set(draftKey(w, live.path), live)
    draftsRef.current = moved
    setDraftCount(moved.size)
    wsRef.current = w
    // The folder panel keeps its tab and open folders when the same folder is read again.
    if (!reload) setPanelKey(w.id)
    setWs(w); setScan(null)
    if (!reload) { setQuery(''); setFilters({}) }
    const first = start && w.files.has(start) ? start : startFile(w)!
    const prev = liveDoc()
    if (await openPath(first, { history: 'replace', force: !reload, fresh: true }) && !reload) {
      setToast({ msg: `Opened ${w.name} · ${w.docs.length.toLocaleString()} Markdown file${w.docs.length === 1 ? '' : 's'}`, undo: prev.path ? undefined : prev })
    }
    if (w.handle) { if (reload) touchFolderPath(w.handle, first); else addRecent({ kind: 'folder', name: w.name, handle: w.handle, path: first }).then(setRecent) }
    else if (w.source === 'zip' && zipBlob) addRecent({ kind: 'zip', name: w.name, blob: zipBlob, path: first }).then(setRecent)
    scanWorkspace(w)
  }, [openPath, okToLeave, liveDoc]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Build the search index and the OKF analysis in the background (again after a save). */
  const scanWorkspace = async (w: Workspace) => {
    if (indexJob.current) indexJob.current.cancelled = true
    const job = { cancelled: false }
    indexJob.current = job
    setIndexing({ done: 0, total: w.docs.length })
    try {
      const { scanFolder } = await import('./scan')
      const result = await scanFolder(w, (done, total) => { if (!job.cancelled) setIndexing({ done, total }) }, job)
      if (!job.cancelled && result) {
        setScan(result); setIndexing(null)
        // Images in a v0.2 bundle may need the root-relative fallback, so show them again.
        if (articleRef.current && result.analysis.okf) showLocalImages(articleRef.current, w, docRef.current.path, rootFallback())
      }
    } catch (e) {
      if (!job.cancelled) { setIndexing(null); setToast({ msg: 'Could not read every file in the folder: ' + String((e as Error)?.message ?? e) }) }
    }
  }

  /** Open a .zip archive as a folder (for example an OKF bundle). */
  const openZipRef = useRef<(f: Blob & { name: string }, start?: string) => void>(() => {})
  openZipRef.current = async (f, start) => {
    if (f.size > 200_000_000) { setToast({ msg: `${f.name} is over 200 MB, which is too large to open here.` }); return }
    try {
      const { fromZip } = await import('./zip')
      const w = await fromZip(f)
      loadWorkspace(w, start, f)
    } catch (e) {
      setToast({ msg: `Could not open ${f.name}: ${String((e as Error)?.message ?? e)}` })
    }
  }

  const openFolder = useCallback(async () => {
    wantNameRef.current = null
    if (!canPickDirectory) { folderRef.current?.click(); return }
    try {
      const handle = await pickDirectory()
      if (handle) loadWorkspace(await fromDirectoryHandle(handle))
    } catch (e) {
      setToast({ msg: 'Could not open the folder: ' + String((e as Error)?.message ?? e) })
    }
  }, [loadWorkspace])

  /**
   * A single file can't see the folder it came from, so its relative images can't be read.
   * This asks for that folder (the picker starts next to the file in Chrome and Edge) and
   * reopens the same file inside it, so images and links to other files work.
   */
  const wantNameRef = useRef<string | null>(null)
  const openFileFolder = async () => {
    const d = docRef.current
    if (!canPickDirectory || !isTopWindow) { wantNameRef.current = d.name; folderRef.current?.click(); return }
    try {
      const dir = await pickDirectory(d.handle)
      if (!dir) return
      const w = await fromDirectoryHandle(dir)
      const rel: string[] | null = d.handle ? await (dir as any).resolve(d.handle).catch(() => null) : null
      const path = rel?.length ? rel.join('/') : fileNamed(w, d.name)
      if (!path) setToast({ msg: `${d.name} isn't in ${w.name}, so its images still can't be shown.` })
      loadWorkspace(w, path ?? undefined)
    } catch (e) {
      setToast({ msg: 'Could not open the folder: ' + String((e as Error)?.message ?? e) })
    }
  }
  const openFileFolderRef = useRef(openFileFolder)
  openFileFolderRef.current = openFileFolder

  const openRecent = useCallback(async (r: RecentEntry) => {
    // The stored entry knows which file was open last.
    r = (await listRecent()).find((x) => x.id === r.id) ?? r
    if (r.kind === 'file') {
      if (r.text === undefined) return
      if (!okToLeave(true)) return
      closeFolder()
      replaceDoc({ name: r.name, text: r.text }, `Opened ${r.name}`)
      addRecent({ kind: 'file', name: r.name, text: r.text }).then(setRecent)
      return
    }
    if (r.kind === 'zip') { if (r.blob) openZipRef.current(new File([r.blob], r.name + '.zip', { type: 'application/zip' }), r.path); return }
    if (!r.handle) return
    if (!(await ensurePermission(r.handle))) { setToast({ msg: `Access to ${r.name} wasn't allowed.` }); return }
    try { loadWorkspace(await fromDirectoryHandle(r.handle), r.path) }
    catch { setToast({ msg: `Could not open ${r.name}. It may have been moved or deleted.` }); removeRecent(r.id).then(setRecent) }
  }, [closeFolder, replaceDoc, loadWorkspace, okToLeave])

  /* Files opened from the operating system when the app is installed (file handlers). */
  useEffect(() => {
    const lq = (window as any).launchQueue
    lq?.setConsumer?.(async (params: { files?: FileSystemFileHandle[] }) => {
      const h = params.files?.[0]
      if (h) readFile(await h.getFile(), h)
    })
  }, [readFile])

  /* install button */
  useEffect(() => {
    const before = (e: Event) => { e.preventDefault(); setInstallPrompt(e) }
    const installed = () => setInstallPrompt(null)
    window.addEventListener('beforeinstallprompt', before)
    window.addEventListener('appinstalled', installed)
    return () => { window.removeEventListener('beforeinstallprompt', before); window.removeEventListener('appinstalled', installed) }
  }, [])
  const install = async () => {
    if (!installPrompt) return
    installPrompt.prompt()
    try { await installPrompt.userChoice } finally { setInstallPrompt(null) }
  }

  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const onlyImages = (dt: DataTransfer | null) => {
      const items = Array.from(dt?.items ?? []).filter((i) => i.kind === 'file')
      return items.length > 0 && items.every((i) => i.type.startsWith('image/'))
    }
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault(); depth++
      setDragging(viewRef.current === 'edit' && onlyImages(e.dataTransfer) ? 'image' : 'open')
    }
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false) }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault(); depth = 0; setDragging(false)
      const dt = e.dataTransfer
      if (!dt) return
      // Images dropped while editing go into the document, where they were dropped.
      if (viewRef.current === 'edit' && onlyImages(dt)) {
        addImagesRef.current(Array.from(dt.files), edRef.current?.posAt(e.clientX, e.clientY) ?? null)
        return
      }
      // Entries and handles must be requested during the drop event itself.
      const item = Array.from(dt.items).find((i) => i.kind === 'file')
      const entry = item?.webkitGetAsEntry?.()
      const handleP: Promise<FileSystemHandle | null> | undefined = (item as any)?.getAsFileSystemHandle?.()
      const files = Array.from(dt.files)
      if (entry?.isDirectory) {
        ;(async () => {
          const h = await handleP?.catch(() => null)
          loadWorkspace(h?.kind === 'directory' ? await fromDirectoryHandle(h as FileSystemDirectoryHandle) : await fromDroppedEntry(entry as FileSystemDirectoryEntry))
        })().catch((err) => setToast({ msg: 'Could not open the folder: ' + String(err?.message ?? err) }))
      } else if (files.length > 1) {
        loadWorkspace(fromFileList(files.filter((f) => isMarkdownName(f.name))))
      } else if (files[0]) {
        // Chrome and Edge give a handle for a dropped file too, so it can be saved back.
        Promise.resolve(handleP).then((h) => h, () => null).then((h) => readFile(files[0], h?.kind === 'file' ? (h as FileSystemFileHandle) : undefined))
      }
    }
    window.addEventListener('dragenter', enter); window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave); window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop)
    }
  }, [readFile, loadWorkspace])

  /* keyboard shortcuts */
  const exportPdfRef = useRef<() => void>(() => {})
  const openFindRef = useRef<() => void>(() => {})
  openFindRef.current = () => {
    if (viewRef.current === 'graph') setView('preview')
    const sel = window.getSelection()?.toString().trim() ?? ''
    const inPage = !!window.getSelection()?.anchorNode?.parentElement?.closest('.reading')
    setFind((f) => ({ n: (f?.n ?? 0) + 1, seed: inPage && sel && sel.length <= 120 && !sel.includes('\n') ? sel : undefined }))
  }
  const closeFind = useCallback(() => { setFind(null); mainRef.current?.focus({ preventScroll: true }) }, [])
  const searchAllFiles = useCallback((q: string) => {
    if (q) setQuery(q)
    setFind(null)
    if (window.matchMedia('(max-width: 900px)').matches) setDrawer(true)
    requestAnimationFrame(() => { const s = document.querySelectorAll<HTMLInputElement>('.search input'); s[s.length - 1]?.focus(); s[s.length - 1]?.select() })
  }, [])
  const openFolderRef = useRef<() => void>(() => {})
  openFolderRef.current = openFolder
  const openFileRef = useRef<() => void>(() => {})
  openFileRef.current = openFile
  const newDocRef = useRef<() => void>(() => {})
  const saveRef = useRef<(as: boolean) => void>(() => {})
  const toggleEditRef = useRef<() => void>(() => {})
  const addImagesRef = useRef<(files: File[], at?: number | null) => void>(() => {})
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      // The editor has its own find (Ctrl+F), link (Ctrl+K) and plain paste (Ctrl+Shift+V).
      const inEditor = !!(e.target as Element)?.closest?.('.cm-editor')
      // Ctrl+Alt is AltGr on Windows (AltGr+N types "ń" in Polish), so the key itself must be "n" there.
      if (mod && e.altKey && !e.shiftKey && e.code === 'KeyN' && (isMac || e.key.toLowerCase() === 'n')) { e.preventDefault(); newDocRef.current() }
      else if (mod && !e.altKey && e.code === 'KeyS') { e.preventDefault(); saveRef.current(e.shiftKey) }
      else if (mod && e.shiftKey && !e.altKey && e.code === 'KeyE') { e.preventDefault(); toggleEditRef.current() }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openFolderRef.current() }
      else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openFileRef.current() }
      else if (inEditor && mod && ['f', 'k', 'h', 'v'].includes(e.key.toLowerCase())) return
      else if (inEditor && e.key === 'F3') return
      else if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') {
        // A second Ctrl+F while the find box has focus falls through to the browser's own search.
        if (viewRef.current === 'graph' || (findOpenRef.current && (e.target as Element)?.closest?.('.find'))) return
        e.preventDefault(); openFindRef.current()
      }
      else if (e.key === 'F3' && findOpenRef.current && !(e.target as Element)?.closest?.('.find')) {
        e.preventDefault()
        document.querySelector<HTMLButtonElement>(e.shiftKey ? '.find-prev' : '.find-prev + .find-btn')?.click()
      }
      else if (mod && e.key.toLowerCase() === 'k' && !wsRef.current) { e.preventDefault(); openFindRef.current() }
      else if (mod && e.key.toLowerCase() === 'k' && wsRef.current) {
        e.preventDefault()
        if (window.matchMedia('(max-width: 900px)').matches) setDrawer(true)
        requestAnimationFrame(() => { const s = document.querySelectorAll<HTMLInputElement>('.search input'); s[s.length - 1]?.focus(); s[s.length - 1]?.select() })
      }
      else if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); exportPdfRef.current() }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'v') { e.preventDefault(); setPasteOpen(true) }
      else if (e.key === 'Escape' && !inEditor) { setDrawer(false); setPasteOpen(false); setFind(null) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t) }, [toast])

  const cycleTheme = () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'))
  const themeLabel = theme === 'system' ? 'Theme: system' : theme === 'light' ? 'Theme: light' : 'Theme: dark'

  /* ---------- export ---------- */
  useEffect(() => { store.set('kmv.exportFm', includeFm) }, [includeFm])
  const hasFm = !!fm?.data && Object.keys(fm.data).length > 0
  const meta = includeFm && hasFm ? metaHtml(fm!.data) : ''
  const fileBase = baseName(typeof fm?.data?.title === 'string' ? fm.data.title : '', doc.name)
  const description = typeof fm?.data?.description === 'string' ? fm.data.description : undefined

  /** Make sure the rendered article is on screen before exporting it. */
  const ensurePreview = useCallback(async () => {
    if (view !== 'preview' && view !== 'edit') { setView('preview'); await new Promise((r) => setTimeout(r, 350)) }
    return articleRef.current
  }, [view])

  const exportPdf = useCallback(async () => {
    await ensurePreview()
    const prevTitle = document.title
    document.title = fileBase // browsers use this as the PDF file name
    document.body.classList.toggle('print-fm', includeFm && hasFm)
    const restore = () => {
      document.title = prevTitle
      document.body.classList.remove('print-fm')
      window.removeEventListener('afterprint', restore)
    }
    window.addEventListener('afterprint', restore)
    try { window.print() } catch { restore(); setToast({ msg: 'Printing is blocked here. Open markdown.kagitha.com to save a PDF.' }) }
  }, [ensurePreview, fileBase, includeFm, hasFm])

  const exportHtml = useCallback(async () => {
    const art = await ensurePreview()
    if (!art) return
    setBusy(true)
    try {
      const page = await buildStandaloneHtml({ article: art, title, description, meta })
      downloadBlob(new Blob([page], { type: 'text/html;charset=utf-8' }), fileBase + '.html')
      setToast({ msg: `Saved ${fileBase}.html` })
    } catch (e) {
      setToast({ msg: 'Could not build the HTML file: ' + String((e as Error)?.message ?? e) })
    } finally { setBusy(false) }
  }, [ensurePreview, title, description, meta, fileBase])

  const exportMd = useCallback(() => {
    const name = /\.(md|markdown)$/i.test(doc.name) && doc.name !== 'pasted.md' ? doc.name : fileBase + '.md'
    downloadBlob(new Blob([doc.text], { type: 'text/markdown;charset=utf-8' }), name)
    setToast({ msg: `Saved ${name}` })
  }, [doc, fileBase])

  const copyFormatted = useCallback(async () => {
    const art = await ensurePreview()
    if (!art) return
    try { await copyRich(art, meta); setToast({ msg: 'Copied. Paste into Google Docs, Word or an email.' }) }
    catch { setToast({ msg: 'Copying was blocked by the browser.' }) }
  }, [ensurePreview, meta])

  const copyMarkdown = useCallback(async () => {
    try { await navigator.clipboard.writeText(doc.text); setToast({ msg: 'Markdown copied' }) }
    catch { setToast({ msg: 'Copying was blocked by the browser.' }) }
  }, [doc.text])

  exportPdfRef.current = exportPdf

  /* ---------- editing ---------- */

  const newDoc = useCallback((template?: string) => {
    if (!okToLeave(false)) return
    const prev = liveDoc()
    const t = template ? TEMPLATES[template] : undefined
    const next: Doc = { name: t?.name ?? 'Untitled.md', text: t?.text() ?? '', saved: null, isNew: true }
    record(next, 'push')
    viewRef.current = 'edit'
    showDoc(next)
    if (!isHomeDoc(prev) && !(prev.isNew && !prev.text.trim())) setToast({ msg: 'New document', undo: prev })
  }, [okToLeave, liveDoc, record, showDoc])
  newDocRef.current = () => newDoc()

  const startEditing = useCallback(() => {
    if (isHomeDoc(docRef.current)) { newDoc(); return }
    setFind(null)
    setView('edit')
    if (layRef.current === 'preview') setLayout('split')
  }, [newDoc])
  toggleEditRef.current = () => (viewRef.current === 'edit' ? setView('preview') : startEditing())

  /** A file name for a document that doesn't have one yet: from its title or first heading. */
  const suggestName = (d: Doc) => {
    if (!d.isNew && d.name !== 'pasted.md' && d.name !== SAMPLE_NAME) return /\.\w+$/.test(d.name) ? d.name : d.name + '.md'
    const f = extractFrontmatter(d.text)
    const h = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(d.text)?.[1]
    const t = (typeof f?.data?.title === 'string' && f.data.title) || h || ''
    if (!t && d.isNew && d.name !== 'Untitled.md') return d.name
    return (t ? baseName(t, '') : 'Untitled') + '.md'
  }

  const saving = useRef(false)
  /** Save back to the file; Save as (or a document without a file) asks where. Browsers without that download a copy. */
  const save = useCallback(async (as = false) => {
    if (saving.current) return false
    const d = liveDoc()
    const w = wsRef.current
    if (!isTopWindow) { setToast({ msg: 'Saving works on markdown.kagitha.com. Here you can copy the Markdown from Export.' }); return false }
    if (!as && !isDirty(d)) { setToast({ msg: d.handle || d.path ? 'No changes to save.' : 'No changes to save. Save as makes a copy.' }); return true }
    const text = d.text
    const mark = (patch: Partial<Doc>) => setDoc((cur) => ({ ...cur, ...patch, saved: text, isNew: false }))
    saving.current = true
    try {
      if (!as) {
        const wf = d.path && w ? w.files.get(d.path) : undefined
        if (wf?.handle && w?.handle) {
          if (!(await ensureWrite(w.handle))) { setToast({ msg: `Saving into ${w.name} wasn't allowed.` }); return false }
          await writeFile(wf.handle, text)
          mark({})
          setToast({ msg: `Saved ${d.path}` })
          scanWorkspace(w)
          return true
        }
        if (d.handle) {
          if (!(await ensureWrite(d.handle))) { setToast({ msg: `Saving ${d.name} wasn't allowed.` }); return false }
          await writeFile(d.handle, text)
          mark({})
          setToast({ msg: `Saved ${d.name}` })
          addRecent({ kind: 'file', name: d.name, text }).then(setRecent)
          return true
        }
      }
      if (canSaveFiles) {
        const h = await pickSaveFile(suggestName(d), w?.handle ?? d.handle)
        if (!h) return false
        await writeFile(h, text)
        // Saved into the opened folder: read the folder again and show the file there.
        const rel: string[] | null = w?.handle ? await (w.handle as any).resolve(h).catch(() => null) : null
        if (w?.handle && rel?.length) {
          mark({})
          loadWorkspace(await fromDirectoryHandle(w.handle), rel.join('/'), undefined, true)
          setToast({ msg: `Saved ${rel.join('/')} in ${w.name}` })
          return true
        }
        mark({ name: h.name, handle: h, path: undefined })
        setToast({ msg: `Saved ${h.name}` })
        addRecent({ kind: 'file', name: h.name, text }).then(setRecent)
        return true
      }
      const name = suggestName(d)
      downloadBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), name)
      mark({ name })
      setToast({ msg: `Downloaded ${name}. This browser can't save over files, so each save downloads a copy.` })
      return true
    } catch (e) {
      setToast({ msg: 'Could not save: ' + String((e as Error)?.message ?? e) })
      return false
    } finally { saving.current = false }
  }, [liveDoc, loadWorkspace]) // eslint-disable-line react-hooks/exhaustive-deps
  saveRef.current = (as) => { save(as) }

  /** Add a new file to the opened folder (Chrome and Edge), then edit it. */
  const createInFolder = useCallback(async (input: string) => {
    const w = wsRef.current
    if (!w?.handle) return
    let path = input.replace(/\\/g, '/').replace(/^\/+/, '').trim()
    if (!/\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(path)) path += '.md'
    const parts = path.split('/')
    if (parts.some(badName)) { setToast({ msg: `“${input}” isn't a valid file name.` }); return }
    if (w.files.has(path)) { setToast({ msg: `${path} already exists.` }); return }
    setFileDialog(null)
    try {
      if (!(await ensureWrite(w.handle))) { setToast({ msg: `Adding files to ${w.name} wasn't allowed.` }); return }
      const stem = parts[parts.length - 1].replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
      const heading = stem ? stem[0].toUpperCase() + stem.slice(1) : 'Untitled'
      await createFileIn(w.handle, path, `# ${heading}\n\n`)
      viewRef.current = 'edit'
      await loadWorkspace(await fromDirectoryHandle(w.handle), path, undefined, true)
      setView('edit')
      setToast({ msg: `Created ${path}` })
    } catch (e) {
      setToast({ msg: 'Could not create the file: ' + String((e as Error)?.message ?? e) })
    }
  }, [loadWorkspace])

  /* ---------- managing files in the folder (Chrome and Edge) ---------- */
  const canManage = !!ws?.handle && isTopWindow
  type FileDialog =
    | { kind: 'newFile' | 'newFolder'; dir: string }
    | { kind: 'rename' | 'move'; path: string }
  const [fileDialog, setFileDialog] = useState<FileDialog | null>(null)

  /** Moving files rewrites links in other files, so their unsaved changes must be saved first. */
  const unsavedInFolder = () => {
    const d = liveDoc()
    if (d.path && isDirty(d)) return d.path
    const first = draftsRef.current.values().next().value
    return first?.path ?? null
  }
  const writable = async (w: Workspace) => {
    if (await ensureWrite(w.handle!)) return true
    setToast({ msg: `Changing files in ${w.name} wasn't allowed.` })
    return false
  }
  /** Read the folder again; the open file stays open (at its new path when it moved). */
  const reread = async (w: Workspace, open?: string) => {
    const next = await fromDirectoryHandle(w.handle!)
    await loadWorkspace(next, open && next.files.has(open) ? open : undefined, undefined, true)
  }

  const createFolderAt = useCallback(async (input: string, dir: string) => {
    const w = wsRef.current
    if (!w?.handle) return
    const path = (dir + input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim()).replace(/^\/+/, '') + '/'
    if (path.split('/').filter(Boolean).some(badName)) { setToast({ msg: `“${input}” isn't a valid folder name.` }); return }
    if (w.dirs?.includes(path)) { setToast({ msg: `${path} already exists.` }); return }
    setFileDialog(null)
    try {
      if (!(await writable(w))) return
      await createFolder(w.handle, path)
      await reread(w, docRef.current.path)
      setToast({ msg: `Created the folder ${path}` })
    } catch (e) { setToast({ msg: 'Could not create the folder: ' + String((e as Error)?.message ?? e) }) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Rename or move a file or folder, and update the links that point at it (and the links inside it). */
  const relocate = useCallback(async (from: string, toInput: string) => {
    const w = wsRef.current
    if (!w?.handle) return
    const isDir = from.endsWith('/')
    let to = toInput.replace(/\\/g, '/').replace(/^\/+/, '').trim()
    if (isDir) to = to.replace(/\/*$/, '/')
    else if (!/\.[^./]+$/.test(to) && /\.(md|markdown)$/i.test(from)) to += '.md'
    if (to === from) { setFileDialog(null); return }
    if (to.split('/').filter(Boolean).some(badName)) { setToast({ msg: `“${toInput}” isn't a valid name.` }); return }
    if (isDir && to.startsWith(from)) { setToast({ msg: 'A folder can’t be moved into itself.' }); return }
    const taken = isDir ? w.dirs?.includes(to) || [...w.files.keys()].some((p) => p.startsWith(to)) : w.files.has(to) || w.dirs?.includes(to + '/')
    if (taken) { setToast({ msg: `${to} already exists.` }); return }
    const unsaved = unsavedInFolder()
    if (unsaved) { setToast({ msg: `Save your changes to ${unsaved} first (${keyLabel(KEYS.save)}).` }); return }
    setFileDialog(null)
    try {
      if (!(await writable(w))) return
      // Every file that moves, old path → new path.
      const moves = new Map<string, string>()
      for (const p of w.files.keys()) {
        if (isDir ? p.startsWith(from) : p === from) moves.set(p, isDir ? to + p.slice(from.length) : to)
      }
      // Work out the new text of every file whose links change, before anything moves.
      const { relinker } = await import('./relink')
      const r = relinker(w, moves, rootFallback())
      const names = [...moves.keys()].map((p) => p.split('/').pop()!.replace(/\.[^.]+$/, ''))
      if (isDir) names.push(from.replace(/\/$/, '').split('/').pop()!)
      const updates = new Map<string, string>()
      let linkCount = 0
      for (const p of w.docs) {
        const moved = moves.get(p)
        const newSelf = moved ?? p
        // Only files that move to another folder, or that mention a moved name, can have links to fix.
        const text = await (await w.files.get(p)!.get()).text()
        if (!(moved && dirOf(moved) !== dirOf(p)) && !names.some((n) => text.includes(n))) continue
        const out = r.rewrite(text, p, newSelf)
        if (out.count) { updates.set(newSelf, out.text); linkCount += out.count }
      }
      await moveAt(w.handle, from, to)
      for (const [p, text] of updates) await writeAt(w.handle, p, text)
      const cur = docRef.current.path
      await reread(w, cur ? moves.get(cur) ?? cur : undefined)
      const verb = dirOf(from.replace(/\/$/, '')) === dirOf(to.replace(/\/$/, '')) ? 'Renamed' : 'Moved'
      setToast({ msg: `${verb} ${from} to ${to}${updates.size ? ` · updated ${linkCount} link${linkCount === 1 ? '' : 's'} in ${updates.size} file${updates.size === 1 ? '' : 's'}` : ''}` })
    } catch (e) {
      setToast({ msg: 'Could not move it: ' + String((e as Error)?.message ?? e) })
      reread(w, docRef.current.path).catch(() => {})
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const duplicate = useCallback(async (path: string) => {
    const w = wsRef.current
    const f = w?.files.get(path)
    if (!w?.handle || !f) return
    const m = /^(.*?)(\.[^./]+)?$/.exec(path)!
    let copy = `${m[1]} copy${m[2] ?? ''}`
    for (let n = 2; w.files.has(copy); n++) copy = `${m[1]} copy ${n}${m[2] ?? ''}`
    try {
      if (!(await writable(w))) return
      await writeAt(w.handle, copy, await f.get())
      await reread(w, docRef.current.path)
      setToast({ msg: `Made ${copy}` })
    } catch (e) { setToast({ msg: 'Could not copy it: ' + String((e as Error)?.message ?? e) }) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Delete a file or folder from the disk, after asking. */
  const removeEntry = useCallback(async (path: string) => {
    const w = wsRef.current
    if (!w?.handle) return
    const isDir = path.endsWith('/')
    const inside = isDir ? [...w.files.keys()].filter((p) => p.startsWith(path)).length : 0
    const what = isDir ? `the folder ${path}${inside ? ` and the ${inside.toLocaleString()} file${inside === 1 ? '' : 's'} in it` : ''}` : path
    let ok = false
    try { ok = window.confirm(`Delete ${what}?\n\nIt is deleted from your disk, not moved to the Recycle Bin or Trash.`) } catch { ok = false }
    if (!ok) return
    try {
      if (!(await writable(w))) return
      await removeAt(w.handle, path)
      // Drafts of deleted files go too.
      for (const k of [...draftsRef.current.keys()]) { const p = k.slice(k.indexOf(':') + 1); if (isDir ? p.startsWith(path) : p === path) draftsRef.current.delete(k) }
      setDraftCount(draftsRef.current.size)
      const cur = docRef.current.path
      const gone = !!cur && (isDir ? cur.startsWith(path) : cur === path)
      if (gone) setDoc((d) => ({ ...d, saved: d.text })) // nothing left to save it to
      await reread(w, gone ? undefined : cur)
      setToast({ msg: `Deleted ${path}` })
    } catch (e) { setToast({ msg: 'Could not delete it: ' + String((e as Error)?.message ?? e) }) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const treeActions = useMemo<TreeActions | undefined>(() => canManage ? {
    newFile: (dir) => setFileDialog({ kind: 'newFile', dir }),
    newFolder: (dir) => setFileDialog({ kind: 'newFolder', dir }),
    rename: (path) => setFileDialog({ kind: 'rename', path }),
    move: (path) => setFileDialog({ kind: 'move', path }),
    moveTo: (path, dir) => relocate(path, dir + path.replace(/\/$/, '').split('/').pop()! + (path.endsWith('/') ? '/' : '')),
    duplicate,
    remove: removeEntry,
  } : undefined, [canManage, relocate, duplicate, removeEntry])

  /* ---------- images: paste, drop or pick ---------- */
  const imageInputRef = useRef<HTMLInputElement>(null)
  const MAX_EMBED = 1_500_000
  /** Save images next to the document (images/ in the opened folder), or embed them when there's no folder to save into. */
  const addImages = useCallback(async (files: File[], at: number | null = null) => {
    const api = edRef.current
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    if (!api || !imgs.length) return
    const d = docRef.current
    const w = wsRef.current
    const alt = (f: File) => {
      const stem = f.name.replace(/\.[^.]+$/, '')
      return /^(image|screenshot|clipboard|untitled|pasted.*)$/i.test(stem) || !stem ? 'image' : stem.replace(/[-_]+/g, ' ').trim()
    }
    const ext = (f: File) => (/\.([a-z0-9]+)$/i.exec(f.name)?.[1] ?? f.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png').toLowerCase()
    const parts: string[] = []
    try {
      if (w?.handle && d.path && isTopWindow) {
        if (!(await writable(w))) return
        const dir = dirOf(d.path) + 'images/'
        const saved: string[] = []
        for (const f of imgs) {
          if (f.size > 25_000_000) { setToast({ msg: `${f.name} is over 25 MB, so it wasn't added.` }); continue }
          const named = alt(f) !== 'image' && f.name
          const now = new Date()
          const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
          const base = (named ? f.name.replace(/\.[^.]+$/, '') : `image-${stamp}`).normalize('NFKD').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'image'
          let name = `${base}.${ext(f)}`
          for (let n = 2; w.files.has(dir + name); n++) name = `${base}-${n}.${ext(f)}`
          const fh = await writeAt(w.handle, dir + name, f)
          // Known to the folder at once, so the preview shows it without reading the folder again.
          w.files.set(dir + name, { path: dir + name, name, kind: 'image', get: () => fh.getFile(), handle: fh })
          parts.push(`![${alt(f)}](images/${encodeURIComponent(name).replace(/%2F/g, '/')})`)
          saved.push(name)
        }
        if (!parts.length) return
        api.insert(parts.join('\n\n'), at)
        setToast({ msg: saved.length === 1 ? `Saved images/${saved[0]} next to ${d.name}` : `Saved ${saved.length} images in images/ next to ${d.name}` })
        return
      }
      // No folder to save into: embed the image in the file itself, defined at the end so the text stays readable.
      const used = new Set([...(api.getText().matchAll(/^\[(image-\d+)\]:/gm))].map((m) => m[1]))
      const defs: string[] = []
      let n = 1
      for (const f of imgs) {
        if (f.size > MAX_EMBED) { setToast({ msg: `${f.name || 'The image'} is too large to put inside the file (over 1.5 MB). Open the folder the file is in to save images next to it.` }); continue }
        const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f) })
        while (used.has(`image-${n}`)) n++
        used.add(`image-${n}`)
        parts.push(`![${alt(f)}][image-${n}]`)
        defs.push(`[image-${n}]: ${url}`)
      }
      if (!parts.length) return
      api.insert(parts.join('\n\n'), at, defs)
      setToast({ msg: canManage || !d.path ? 'Image added inside the file. To save images as separate files, open the file’s folder with Folder.' : 'Image added inside the file.' })
    } catch (e) {
      setToast({ msg: 'Could not add the image: ' + String((e as Error)?.message ?? e) })
    }
  }, [canManage]) // eslint-disable-line react-hooks/exhaustive-deps
  addImagesRef.current = addImages
  const pickImages = useCallback(() => {
    if (layRef.current === 'preview') setLayout('split')
    imageInputRef.current?.click()
  }, [])

  const onEditorChange = useCallback((text: string, key: number) => {
    if (key !== docKeyRef.current) return
    setDoc((d) => (d.text === text ? d : { ...d, text }))
  }, [])
  const onEditorReady = useCallback((api: EditorApi | null) => { edRef.current = api }, [])

  const FAIL: Record<string, string> = {
    clear: 'Select the text to clear first.',
    taskDone: 'Put the cursor on a task list item (- [ ]).',
    delRow: 'Put the cursor in a row below the table header.',
    delCol: 'Put the cursor in a table with more than one column.',
  }
  /** Run an editor command from the menu bar or the toolbar. */
  const exec = useCallback((id: string) => {
    if (id === 'pickImage') { pickImages(); return }
    const api = edRef.current
    if (!api) return
    if (layRef.current === 'preview') setLayout('split')
    if (!api.exec(id)) {
      const table = ['rowAbove', 'rowBelow', 'colLeft', 'colRight', 'alignLeft', 'alignCenter', 'alignRight', 'formatTable']
      setToast({ msg: FAIL[id] ?? (table.includes(id) ? 'Put the cursor inside a table first.' : 'That doesn’t apply here.') })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* Warn before closing the tab with changes that would be lost (new documents are kept in the browser). */
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      const d = docRef.current
      if ((isDirty(d) && (d.handle || d.path || d.text.length >= MAX_SAVE)) || draftsRef.current.size) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', before)
    return () => window.removeEventListener('beforeunload', before)
  }, [])

  /* ---------- keeping the editor and the preview in step ---------- */
  /** Which side the person is scrolling; the other one follows. */
  const driver = useRef<'editor' | 'preview'>('editor')
  /** Scroll positions set by syncing, so their scroll events aren't taken for the person's. */
  const echo = useRef({ editor: -1, preview: -1 })
  const lineEls = useRef<{ el: HTMLElement; line: number }[] | null>(null)
  const blocks = () => {
    if (!lineEls.current) {
      lineEls.current = Array.from(articleRef.current?.querySelectorAll<HTMLElement>('[data-line]') ?? [])
        .map((el) => ({ el, line: +(el.dataset.line ?? 0) }))
        .filter((b) => b.line > 0)
    }
    return lineEls.current
  }
  const syncRef = useRef<(from: 'editor' | 'preview') => void>(() => {})
  syncRef.current = (from) => {
    const api = edRef.current, pane = mainRef.current
    if (!api || !pane || !syncScroll || layRef.current !== 'split' || viewRef.current !== 'edit') return
    const list = blocks()
    if (!list.length) return
    const paneTop = pane.getBoundingClientRect().top - pane.scrollTop
    const top = (b: { el: HTMLElement }) => b.el.getBoundingClientRect().top - paneTop - 16
    if (from === 'editor') {
      const line = api.topLine()
      let i = -1
      for (let lo = 0, hi = list.length - 1; lo <= hi;) { const mid = (lo + hi) >> 1; if (list[mid].line <= line) { i = mid; lo = mid + 1 } else hi = mid - 1 }
      let y: number
      if (i < 0) y = 0
      else {
        const a = list[i], b = list[i + 1]
        const ya = top(a), yb = b ? top(b) : pane.scrollHeight
        const la = a.line, lb = b ? b.line : la + Math.max(1, line - la + 1)
        y = ya + (yb - ya) * Math.min(1, (line - la) / Math.max(1, lb - la))
      }
      if (line <= 1.01) y = 0
      const max = pane.scrollHeight - pane.clientHeight
      pane.scrollTop = Math.max(0, Math.min(max, y))
      echo.current.preview = pane.scrollTop
    } else {
      const y = pane.scrollTop
      let i = -1
      for (let lo = 0, hi = list.length - 1; lo <= hi;) { const mid = (lo + hi) >> 1; if (top(list[mid]) <= y) { i = mid; lo = mid + 1 } else hi = mid - 1 }
      let line = 1
      if (i >= 0) {
        const a = list[i], b = list[i + 1]
        const ya = top(a), yb = b ? top(b) : pane.scrollHeight
        line = a.line + (b ? (b.line - a.line) : 1) * Math.min(1, (y - ya) / Math.max(1, yb - ya))
      }
      if (y <= 0) line = 1
      api.scrollToLine(line)
    }
  }
  const syncFrame = useRef(0)
  const onEditorScroll = useCallback(() => {
    if (driver.current !== 'editor' || syncFrame.current) return
    syncFrame.current = requestAnimationFrame(() => { syncFrame.current = 0; syncRef.current('editor') })
  }, [])
  useEffect(() => {
    const pane = mainRef.current
    if (!pane || view !== 'edit') return
    const onScroll = () => {
      if (Math.abs(pane.scrollTop - echo.current.preview) < 2) return
      if (driver.current !== 'preview' || syncFrame.current) return
      syncFrame.current = requestAnimationFrame(() => { syncFrame.current = 0; syncRef.current('preview') })
    }
    pane.addEventListener('scroll', onScroll, { passive: true })
    return () => pane.removeEventListener('scroll', onScroll)
  }, [view])
  // The editor re-measures and catches up after being hidden or resized.
  useEffect(() => { if (view === 'edit') requestAnimationFrame(() => { edRef.current?.refresh(); syncRef.current('editor') }) }, [view, lay])

  /** Double-click in the preview: put the editor's cursor on that block. */
  const onPreviewDouble = useCallback((e: React.MouseEvent) => {
    if (viewRef.current !== 'edit' || layRef.current === 'preview') return
    let el = e.target as HTMLElement | null
    while (el && el !== articleRef.current && !el.dataset?.line) el = el.parentElement
    const line = el?.dataset?.line
    if (line) { driver.current = 'editor'; edRef.current?.goto(+line) }
  }, [])

  /* ---------- the menu bar ---------- */
  const headingNow = cursor ? (/^\s{0,3}(#{1,6})(\s|$)/.exec(cursor.text)?.[1].length ?? 0) : 0
  const ed = (label: string, id: string, extra: Partial<Exclude<MenuItem, '-'>> = {}): MenuItem => ({ label, keys: KEYS[id.split(':')[0]], run: () => exec(id), ...extra })
  const canFolderFile = !!ws?.handle && isTopWindow
  const menus: MenuDef[] = [
    {
      label: 'File',
      items: [
        { label: 'New document', icon: 'newfile', keys: KEYS.new, run: () => newDoc() },
        {
          label: 'New from template', sub: [
            { label: 'Note with front matter', run: () => newDoc('note') },
            { label: 'README', run: () => newDoc('readme') },
            { label: 'OKF concept file', run: () => newDoc('okf') },
          ],
        },
        {
          label: 'New file in folder…', run: () => setFileDialog({ kind: 'newFile', dir: dirOf(doc.path ?? '') }), disabled: !canFolderFile,
          hint: canFolderFile ? undefined : ws ? 'Needs a folder opened in Chrome or Edge' : 'Open a folder first',
        },
        { label: 'New folder…', icon: 'folderplus', run: () => setFileDialog({ kind: 'newFolder', dir: dirOf(doc.path ?? '') }), disabled: !canFolderFile },
        '-',
        { label: 'Open file…', icon: 'file', keys: KEYS.open, run: openFile },
        { label: 'Open folder…', icon: 'folder', keys: KEYS.openFolder, run: openFolder },
        '-',
        { label: 'Save', icon: 'save', keys: KEYS.save, run: () => save(false) },
        { label: 'Save as…', keys: KEYS.saveAs, run: () => save(true) },
        { label: 'Download .md', icon: 'download', run: exportMd, disabled: !isTopWindow },
        '-',
        { label: 'Rename file…', icon: 'edit', run: () => doc.path && setFileDialog({ kind: 'rename', path: doc.path }), disabled: !canFolderFile || !doc.path },
        { label: 'Move file…', icon: 'move', run: () => doc.path && setFileDialog({ kind: 'move', path: doc.path }), disabled: !canFolderFile || !doc.path },
        { label: 'Duplicate file', icon: 'copy', run: () => doc.path && duplicate(doc.path), disabled: !canFolderFile || !doc.path },
        { label: 'Delete file…', icon: 'trash', run: () => doc.path && removeEntry(doc.path), disabled: !canFolderFile || !doc.path },
        '-',
        { label: 'Export PDF', icon: 'pdf', keys: KEYS.print, run: exportPdf },
        { label: 'Export HTML', icon: 'code', run: exportHtml, disabled: !isTopWindow },
        { label: 'Copy as formatted text', icon: 'rich', run: copyFormatted },
        '-',
        { label: 'Close editor', icon: 'eye', keys: KEYS.toggleEdit, run: () => setView('preview') },
      ],
    },
    {
      label: 'Edit',
      items: [
        ed('Undo', 'undo', { icon: 'undo' }), ed('Redo', 'redo', { icon: 'redo' }),
        '-',
        ed('Select all', 'selectAll'),
        '-',
        ed('Find', 'find', { icon: 'search' }), ed('Replace', 'replace'), ed('Go to line…', 'gotoLine'),
        '-',
        ed('Duplicate line', 'duplicateLine'), ed('Move line up', 'moveLineUp'), ed('Move line down', 'moveLineDown'), ed('Delete line', 'deleteLine'),
        ed('Comment out', 'comment', { hint: '<!-- hidden in the preview -->' }),
      ],
    },
    {
      label: 'Format',
      items: [
        ed('Bold', 'bold', { icon: 'bold' }), ed('Italic', 'italic', { icon: 'italic' }), ed('Strikethrough', 'strike', { icon: 'strike' }),
        ed('Inline code', 'code', { icon: 'inline' }), ed('Inline math', 'inlineMath', { icon: 'math' }),
        '-',
        ed('Link', 'link', { icon: 'link' }),
        '-',
        ed('Clear formatting', 'clear'),
      ],
    },
    {
      label: 'Paragraph',
      items: [
        ed('Paragraph', 'p', { radio: true, checked: headingNow === 0 }),
        ...[1, 2, 3, 4, 5, 6].map((n) => ed('Heading ' + n, 'h' + n, { radio: true, checked: headingNow === n })),
        '-',
        ed('Increase heading level', 'headingUp'), ed('Decrease heading level', 'headingDown'),
        '-',
        ed('Bulleted list', 'ul', { icon: 'ul' }), ed('Numbered list', 'ol', { icon: 'ol' }), ed('Task list', 'task', { icon: 'task' }),
        ed('Mark task done / not done', 'taskDone'), ed('Quote', 'quote', { icon: 'quote' }),
        '-',
        ed('Indent', 'indent'), ed('Outdent', 'outdent'),
        '-',
        ed('Insert paragraph before', 'paragraphBefore'), ed('Insert paragraph after', 'paragraphAfter'),
      ],
    },
    {
      label: 'Insert',
      items: [
        ed('Link', 'link', { icon: 'link' }), ed('Link reference', 'linkRef'),
        { label: 'Image from your computer…', icon: 'image', run: pickImages, hint: 'Or paste or drop an image' },
        ed('Image link', 'image'), ed('Footnote', 'footnote'),
        '-',
        {
          label: 'Table', icon: 'table', sub: [[2, 2], [3, 3], [4, 4], [5, 6]].map(([c, r]) => ed(`${c} columns × ${r} rows`, `table:${c}x${r + 1}`)),
        },
        ed('Code block', 'codeBlock', { icon: 'codeblock' }), ed('Math block', 'mathBlock', { icon: 'math' }), ed('Diagram (Mermaid)', 'mermaid', { icon: 'graph' }),
        {
          label: 'Alert', icon: 'alert', sub: ['Note', 'Tip', 'Important', 'Warning', 'Caution'].map((k) => ed(k, 'alert:' + k.toLowerCase())),
        },
        ed('Collapsible section', 'details'), ed('Horizontal line', 'hr', { icon: 'hr' }),
        '-',
        ed('Table of contents', 'toc', { hint: 'Links to the headings' }),
        ed('Front matter', 'frontMatter', { hint: 'title, date, tags' }),
        ed('OKF front matter', 'okfFrontMatter', { hint: 'type, status, generated' }),
        ed('Today’s date', 'date'),
      ],
    },
    {
      label: 'Table',
      items: [
        ed('Insert table', 'table:3x3', { icon: 'table' }),
        '-',
        ed('Add row above', 'rowAbove'), ed('Add row below', 'rowBelow'), ed('Add column left', 'colLeft'), ed('Add column right', 'colRight'),
        '-',
        ed('Delete row', 'delRow'), ed('Delete column', 'delCol'),
        '-',
        ed('Align column left', 'alignLeft'), ed('Align column center', 'alignCenter'), ed('Align column right', 'alignRight'),
        '-',
        ed('Tidy table', 'formatTable', { hint: 'Line up the columns' }),
      ],
    },
    {
      label: 'View',
      items: [
        { label: narrow ? 'Editor' : 'Editor only', radio: true, checked: lay === 'write', run: () => setLayout('write') },
        ...(narrow ? [] : [{ label: 'Editor and preview', radio: true, checked: lay === 'split', run: () => setLayout('split') }]),
        { label: narrow ? 'Preview' : 'Preview only', radio: true, checked: lay === 'preview', run: () => setLayout('preview') },
        '-',
        ...(narrow ? [] : [{ label: 'Scroll together', checked: syncScroll, run: () => setSyncScroll((v) => !v) }]),
        { label: 'Line numbers', checked: lineNums, run: () => setLineNums((v) => !v) },
        { label: 'Wrap long lines', checked: wrap, run: () => setWrap((v) => !v) },
        ...(narrow ? [] : [{ label: 'Sidebar', checked: edSide, run: () => setEdSide((v) => !v), hint: 'Details and outline' }]),
        '-',
        {
          label: 'Theme', sub: (['system', 'light', 'dark'] as Theme[]).map((t) => ({
            label: t === 'system' ? 'Match the system' : t === 'light' ? 'Light' : 'Dark', radio: true, checked: theme === t, run: () => setTheme(t),
          })),
        },
        '-',
        { label: 'Reading view', icon: 'eye', keys: KEYS.toggleEdit, run: () => setView('preview') },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Keyboard shortcuts', icon: 'keyboard', run: () => setKeysOpen(true) },
        { label: 'Markdown syntax guide', icon: 'link', run: () => window.open('https://www.markdownguide.org/basic-syntax/', '_blank', 'noopener') },
        { label: 'OKF specification', icon: 'link', run: () => window.open('https://github.com/open-knowledge-format/open-knowledge-format', '_blank', 'noopener') },
      ],
    },
  ]
  const tools: ToolDef[][] = [
    [{ id: 'undo', icon: 'undo', label: 'Undo', keys: KEYS.undo }, { id: 'redo', icon: 'redo', label: 'Redo', keys: KEYS.redo }],
    [
      { id: 'bold', icon: 'bold', label: 'Bold', keys: KEYS.bold }, { id: 'italic', icon: 'italic', label: 'Italic', keys: KEYS.italic },
      { id: 'strike', icon: 'strike', label: 'Strikethrough', keys: KEYS.strike }, { id: 'code', icon: 'inline', label: 'Inline code', keys: KEYS.code },
    ],
    [
      { id: 'link', icon: 'link', label: 'Link', keys: KEYS.link }, { id: 'pickImage', icon: 'image', label: 'Image (or paste / drop one)' },
      { id: 'table:3x3', icon: 'table', label: 'Table', keys: KEYS.table },
    ],
    [
      { id: 'ul', icon: 'ul', label: 'Bulleted list', keys: KEYS.ul }, { id: 'ol', icon: 'ol', label: 'Numbered list', keys: KEYS.ol },
      { id: 'task', icon: 'task', label: 'Task list', keys: KEYS.task }, { id: 'quote', icon: 'quote', label: 'Quote', keys: KEYS.quote },
    ],
    [
      { id: 'codeBlock', icon: 'codeblock', label: 'Code block', keys: KEYS.codeBlock }, { id: 'mathBlock', icon: 'math', label: 'Math block', keys: KEYS.mathBlock },
      { id: 'alert:note', icon: 'alert', label: 'Alert (note)' }, { id: 'hr', icon: 'hr', label: 'Horizontal line' },
    ],
    [{ id: 'find', icon: 'search', label: 'Find and replace', keys: KEYS.find }],
  ]
  const saveState = !dirty ? 'Saved' : doc.isNew ? 'Not saved yet' : 'Unsaved changes'

  const recentPanel = !ws && (
    <RecentPanel
      items={recent}
      onOpen={openRecent}
      onRemove={(r) => removeRecent(r.id).then(setRecent)}
      onClear={() => { clearRecent(); setRecent([]) }}
    />
  )
  const openFromPanel = useCallback((path: string, o?: OpenOpts) => {
    if (viewRef.current === 'graph' && !o) { openPath(path); return }
    if (viewRef.current === 'source') setView('preview')
    openPath(path, { terms: o?.terms, href: o?.href })
  }, [openPath])
  const filterMatch = useMemo(() => {
    if (!scan || !activeCount(filters)) return null
    const docs = scan.analysis.docs
    return (p: string) => { const d = docs.get(p); return !!d && matches(d, filters) }
  }, [scan, filters])

  const onTocPick = useCallback((id: string) => {
    setDrawer(false)
    if (viewRef.current === 'edit') {
      // Editing: move the cursor to the heading (the preview follows).
      const line = document.getElementById(id)?.dataset.line
      if (line && layRef.current !== 'preview') { driver.current = 'editor'; edRef.current?.goto(+line); return }
    } else setView('preview')
    requestAnimationFrame(() => scrollPaneTo(mainRef.current, document.getElementById(id)))
  }, [])

  const sidebar = (
    <>
      {ws && (
        <FolderPanel
          key={panelKey}
          ws={ws} current={doc.path} query={query} onQuery={setQuery} scan={scan} indexing={indexing}
          filters={filters} onFilters={setFilters}
          searchRef={searchRef} onClose={() => { if (!okToLeave(true)) return; closeFolder(); if (doc.path) goHome(true) }}
          onOpen={openFromPanel} actions={treeActions}
        />
      )}
      {isHome && recentPanel}
      <FrontmatterCard fm={fm} />
      <nav className="panel" aria-labelledby="toc-h">
        <h2 id="toc-h" className="panel-h">Outline</h2>
        {showLoader ? (
          <p className="panel-empty">Reading the file…</p>
        ) : toc.length ? (
          <TocList toc={toc} activeId={activeId} onPick={onTocPick} />
        ) : (
          <p className="panel-empty">No headings yet.</p>
        )}
      </nav>
      {ws && scan && doc.path && <FileLinksPanel analysis={scan.analysis} path={doc.path} onOpen={openFromPanel} />}
      {!isHome && recentPanel}
    </>
  )

  return (
    <div className={'app' + (ws ? ' has-ws' : '') + (view === 'edit' ? ' is-editing' : '')}>
      <header className="bar">
        <div className="brand">
          <a className="brand-home" href="https://kagitha.com" target="_blank" rel="noopener">kagitha</a>
          <span className="brand-sep" aria-hidden="true">/</span>
          <button type="button" className="brand-name" onClick={() => goHome()} title="Home">Markdown Viewer</button>
        </div>
        <div className="file" title={doc.path && ws ? `${ws.name}/${doc.path}` : doc.name}>
          <span className="file-name">
            {doc.path && ws && <span className="file-dir">{ws.name}/{doc.path.slice(0, doc.path.length - doc.name.length)}</span>}
            {doc.name}
          </span>
          {dirty && <span className="file-dirty" title={saveState} role="img" aria-label={saveState} />}
          {!isHome && (
            <button type="button" className="file-close" onClick={() => goHome()} title="Close file and go home" aria-label={`Close ${doc.name}`}>
              <Icon name="close" />
            </button>
          )}
        </div>
        <div className="actions">
          <button type="button" className="btn btn--new" onClick={() => newDoc()} title={`New document (${keyLabel(KEYS.new)})`} aria-label="New document">
            <Icon name="plus" /><span className="btn-text">New</span>
          </button>
          <button type="button" className="btn btn--primary" onClick={openFile} title="Open a Markdown file or a .zip bundle (Ctrl+O)">
            <Icon name="file" /><span className="btn-text">Open</span>
          </button>
          <button type="button" className="btn btn--folder" onClick={openFolder} title="Open a folder (Ctrl+Shift+O)">
            <Icon name="folder" /><span className="btn-text">Folder</span>
          </button>
          <button type="button" className="btn btn--paste" onClick={() => setPasteOpen(true)} title="Paste Markdown (Ctrl+Shift+V)">
            <Icon name="paste" /><span className="btn-text">Paste</span>
          </button>
          <div className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')} title="Preview" aria-label="Preview">
              <span className="seg-ico"><Icon name="eye" /></span><span className="seg-text">Preview</span>
            </button>
            <button type="button" aria-pressed={view === 'edit'} onClick={startEditing} title={`Edit (${keyLabel(KEYS.toggleEdit)})`} aria-label="Edit">
              <span className="seg-ico"><Icon name="edit" /></span><span className="seg-text">Edit</span>
            </button>
            <button type="button" className="seg-source" aria-pressed={view === 'source'} onClick={() => setView('source')} title="Source" aria-label="Source">
              <span className="seg-ico"><Icon name="code" /></span><span className="seg-text">Source</span>
            </button>
            {ws && (
              <button type="button" aria-pressed={view === 'graph'} onClick={() => setView('graph')} title="Graph: map of how the files link together" aria-label="Graph">
                <span className="seg-ico"><Icon name="graph" /></span><span className="seg-text">Graph</span>
              </button>
            )}
          </div>
          <button
            type="button" className={'btn btn--icon' + (find ? ' is-on' : '')} aria-pressed={!!find}
            onClick={() => (find ? closeFind() : openFindRef.current())}
            title="Find in this file (Ctrl+F)" aria-label="Find in this file"
          >
            <Icon name="search" />
          </button>
          <button type="button" className="btn btn--icon" onClick={cycleTheme} title={themeLabel} aria-label={themeLabel}>
            <Icon name={theme === 'system' ? 'auto' : theme === 'light' ? 'sun' : 'moon'} />
          </button>
          <ExportMenu
            canDownload={isTopWindow}
            busy={busy}
            hasFm={hasFm}
            includeFm={includeFm}
            onIncludeFm={setIncludeFm}
            onPdf={exportPdf}
            onHtml={exportHtml}
            onMd={exportMd}
            onCopyRich={copyFormatted}
            onCopyMd={copyMarkdown}
          />
          <button type="button" className="btn btn--icon show-md" onClick={() => setDrawer(true)} aria-label="Show details and outline">
            <Icon name="panel" />
          </button>
        </div>
        <input
          ref={fileRef} type="file" hidden accept=".md,.markdown,.mdown,.mkd,.mdx,.txt,.zip,text/markdown,text/plain,application/zip"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = '' }}
        />
        <input
          ref={folderRef} type="file" hidden multiple
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => {
            const files = e.target.files
            const want = wantNameRef.current
            wantNameRef.current = null
            if (files?.length) { const w = fromFileList(files); loadWorkspace(w, w && want ? fileNamed(w, want) ?? undefined : undefined) }
            e.target.value = ''
          }}
        />
      </header>

      {view === 'edit' && (
        <MenuBar menus={menus}>
          <Toolbar groups={tools} onRun={exec} block={headingNow} onBlock={(n) => exec(n ? 'h' + n : 'p')} />
          <div className="mb-right">
            <span className={'save-state' + (dirty ? ' is-dirty' : '')} role="status">{saveState}</span>
            <button type="button" className="btn btn--sm btn--save" onClick={() => save(false)} title={`Save (${keyLabel(KEYS.save)})`} aria-label="Save">
              <Icon name="save" /><span className="btn-text">Save</span>
            </button>
            <div className="seg seg--sm seg--layout" role="group" aria-label="Layout">
              <button type="button" aria-pressed={lay === 'write'} onClick={() => setLayout('write')} title="Editor only" aria-label="Editor only"><Icon name="edit" /></button>
              {!narrow && <button type="button" aria-pressed={lay === 'split'} onClick={() => setLayout('split')} title="Editor and preview" aria-label="Editor and preview"><Icon name="split" /></button>}
              <button type="button" aria-pressed={lay === 'preview'} onClick={() => setLayout('preview')} title="Preview only" aria-label="Preview only"><Icon name="eye" /></button>
            </div>
          </div>
        </MenuBar>
      )}

      <div className={'body' + (view === 'edit' ? ` body--edit lay-${lay}` + (edSide && !narrow ? ' with-side' : '') : '')}>
        <aside className="side" aria-label="Document details">{sidebar}</aside>

        {edMounted && (
          <section
            className={'editor-pane' + (view === 'edit' ? '' : ' is-hidden')} aria-label="Editor"
            onWheel={() => { driver.current = 'editor' }} onPointerDown={() => { driver.current = 'editor' }}
            onKeyDown={() => { driver.current = 'editor' }} onTouchStart={() => { driver.current = 'editor' }}
          >
            <Suspense fallback={<p className="editor-loading">Loading the editor…</p>}>
              <Editor
                key={docKey} docKey={docKey} initial={doc.text} wrap={wrap} lineNumbers={lineNums}
                onChange={onEditorChange} onReady={onEditorReady} onScroll={onEditorScroll} onCursor={setCursor}
                onFiles={(f) => addImagesRef.current(f)}
              />
            </Suspense>
          </section>
        )}

        <div
          className={'main' + (view === 'graph' ? ' main--graph' : '') + (find && view !== 'graph' ? ' has-find' : '')} ref={mainRef} tabIndex={-1}
          onWheel={() => { driver.current = 'preview' }} onPointerDown={() => { driver.current = 'preview' }}
          onKeyDown={() => { driver.current = 'preview' }} onTouchStart={() => { driver.current = 'preview' }}
        >
          {view === 'graph' && ws ? (
            scan ? (
              <GraphView analysis={scan.analysis} current={doc.path} match={filterMatch} dark={dark} onOpen={(p) => { setView('preview'); openPath(p) }} />
            ) : <p className="graph-msg">Reading files{indexing ? ` (${indexing.done} of ${indexing.total})` : ''}…</p>
          ) : (
          <>
          {find && (
            <FindBar
              getRoot={getFindRoot} pane={mainRef} content={showsArticle ? html : srcHtml + view}
              request={find} big={bigDoc} onClose={closeFind}
              onSearchAll={ws ? searchAllFiles : undefined}
            />
          )}
          {partial && <div className="top-progress" role="progressbar" aria-label={`Loading the rest of ${doc.name}`}><i /></div>}
          <main className="reading">
            {showsArticle && hasFm && (
              <div className="print-meta" dangerouslySetInnerHTML={{ __html: metaHtml(fm!.data) }} />
            )}
            {showsArticle ? (
              <article
                ref={articleRef}
                className={'prose' + (!html ? ' is-loading' : '') + (showLoader ? ' is-stale' : '') + (bigDoc ? ' prose--big' : '')}
                onClick={onArticleClick} onDoubleClick={onPreviewDouble}
                title={view === 'edit' && lay === 'split' ? 'Double-click to edit here' : undefined}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ) : (
              <div ref={sourceRef} className={'source' + (showLoader ? ' is-stale' : '')} dangerouslySetInnerHTML={{ __html: srcHtml }} />
            )}
            {showLoader && (
              <div className="loader" role="status" aria-live="polite">
                <div className="loader-card">
                  <strong>Opening {doc.name}</strong>
                  <span>{lineCount.toLocaleString()} lines · {stats.words.toLocaleString()} words</span>
                  <span className="loader-bar" aria-hidden="true"><i /></span>
                </div>
              </div>
            )}
          </main>
          </>
          )}
        </div>
      </div>

      <footer className="status">
        {view === 'edit' && cursor && (
          <span className="nowrap status-pos">Ln {cursor.line.toLocaleString()}, Col {cursor.col}{cursor.selected ? ` · ${cursor.selected.toLocaleString()} selected` : ''}</span>
        )}
        <span className="nowrap">{stats.words.toLocaleString()} words</span>
        <span className="nowrap">{stats.minutes} min read</span>
        <span className="hide-sm">{lineCount.toLocaleString()} lines</span>
        {partial && <span className="nowrap status-busy" role="status">Loading the rest of the file…</span>}
        {ws && <span className="hide-sm nowrap">{ws.docs.length.toLocaleString()} files in {ws.name}</span>}
        {draftCount > 0 && <span className="nowrap status-busy" title="Changes to other files in the folder that aren't saved yet">{draftCount} other file{draftCount === 1 ? '' : 's'} not saved</span>}
        {scan?.analysis.okf && <span className="hide-sm nowrap">OKF bundle{scan.analysis.okf.version ? ` v${scan.analysis.okf.version}` : ''}</span>}
        {installPrompt && (
          <button type="button" className="status-btn" onClick={install} title="Install the viewer as an app that works offline">
            <Icon name="install" /><span className="hide-xs">Install app</span>
          </button>
        )}
        <span className={'status-right' + (installPrompt ? ' no-auto' : '')}><span><span className="hide-xs">Opened in your browser · n</span><span className="show-xs">N</span>ever uploaded</span></span>
        <a className="status-link hide-sm" href="https://kagitha.com" target="_blank" rel="noopener">Part of kagitha</a>
      </footer>

      {drawer && (
        <div className="drawer-scrim" onClick={() => setDrawer(false)}>
          <aside className="drawer" aria-label="Document details" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-top">
              <strong>Details</strong>
              <button type="button" className="btn btn--icon" onClick={() => setDrawer(false)} aria-label="Close"><Icon name="close" /></button>
            </div>
            {sidebar}
          </aside>
        </div>
      )}

      {dragging && (
        <div className="drop" aria-hidden="true">
          <div className="drop-box">
            <Icon name={dragging === 'image' ? 'image' : 'open'} />
            <strong>{dragging === 'image' ? 'Drop to add the image' : 'Drop to open'}</strong>
            <span>{dragging === 'image'
              ? (ws?.handle && doc.path ? `Saved in images/ next to ${doc.name}` : 'Put inside the file (open its folder to save images separately)')
              : 'a .md file, a folder or a .zip bundle'}</span>
          </div>
        </div>
      )}

      {keysOpen && <ShortcutsDialog menus={menus} onClose={() => setKeysOpen(false)} />}
      {fileDialog?.kind === 'newFile' && (
        <NameDialog
          title={`New file in ${ws?.name ?? 'the folder'}`}
          note="A path inside the folder. Folders in the path are created if they don't exist."
          initial={fileDialog.dir + 'untitled.md'} action="Create" onClose={() => setFileDialog(null)} onSubmit={createInFolder}
        />
      )}
      {fileDialog?.kind === 'newFolder' && (
        <NameDialog
          title="New folder" note={`Inside ${fileDialog.dir || ws?.name + '/'}`}
          initial="new-folder" action="Create" onClose={() => setFileDialog(null)} onSubmit={(v) => createFolderAt(v, fileDialog.dir)}
        />
      )}
      {fileDialog?.kind === 'rename' && (
        <NameDialog
          title={fileDialog.path.endsWith('/') ? 'Rename folder' : 'Rename file'}
          note="Links to it in other files are updated. You can also type a new path to move it."
          initial={fileDialog.path.replace(/\/$/, '')} action="Rename" onClose={() => setFileDialog(null)}
          onSubmit={(v) => relocate(fileDialog.path, v)}
        />
      )}
      {fileDialog?.kind === 'move' && ws && (
        <MoveDialog
          path={fileDialog.path} root={ws.name} dirs={ws.dirs ?? []} onClose={() => setFileDialog(null)}
          onSubmit={(dir) => relocate(fileDialog.path, dir + fileDialog.path.replace(/\/$/, '').split('/').pop()! + (fileDialog.path.endsWith('/') ? '/' : ''))}
        />
      )}
      <input
        ref={imageInputRef} type="file" hidden multiple accept="image/*"
        onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) addImages(f) }}
      />

      {pasteOpen && <PasteDialog onClose={() => setPasteOpen(false)} onSubmit={(text) => { setPasteOpen(false); if (okToLeave(false)) replaceDoc({ name: 'pasted.md', text }, 'Showing pasted Markdown') }} />}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.msg}</span>
          {toast.undo && (
            <button type="button" onClick={() => { const prev = toast.undo!; setToast(null); if (prev.name === SAMPLE_NAME && prev.text === SAMPLE) goHome(); else { lastFileRef.current = prev; showDoc(prev) } }}>Undo</button>
          )}
          <button type="button" aria-label="Dismiss" onClick={() => setToast(null)}><Icon name="close" /></button>
        </div>
      )}
    </div>
  )
}

/**
 * The outline. The list itself only re-renders when the headings change; the highlighted entry
 * is updated directly, so long files with thousands of headings scroll smoothly.
 */
const TocItems = memo(function TocItems({ toc, onPick }: { toc: TocItem[]; onPick: (id: string) => void }) {
  return (
    <>
      {toc.map((t) => (
        <li key={t.id} className={'toc-l' + t.level}>
          <a href={'#' + t.id} data-id={t.id} onClick={(e) => { e.preventDefault(); onPick(t.id) }}>{t.text}</a>
        </li>
      ))}
    </>
  )
})
function TocList({ toc, activeId, onPick }: { toc: TocItem[]; activeId: string; onPick: (id: string) => void }) {
  const ref = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const ul = ref.current
    if (!ul) return
    ul.querySelectorAll('a.is-active').forEach((a) => { a.classList.remove('is-active'); a.removeAttribute('aria-current') })
    const a = activeId ? ul.querySelector<HTMLAnchorElement>(`a[data-id="${CSS.escape(activeId)}"]`) : null
    if (!a) return
    a.classList.add('is-active')
    a.setAttribute('aria-current', 'location')
    // Keep the highlighted entry visible in the sidebar without moving the page.
    const box = ul.closest('.side, .drawer') as HTMLElement | null
    if (box) {
      const r = a.getBoundingClientRect(), b = box.getBoundingClientRect()
      if (r.top < b.top + 40 || r.bottom > b.bottom - 20) box.scrollTop += r.top - b.top - b.height / 3
    }
  }, [activeId, toc])
  return <ul className="toc" ref={ref}><TocItems toc={toc} onPick={onPick} /></ul>
}

function PasteDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (t: string) => void }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  return (
    <div className="drawer-scrim center" onClick={onClose}>
      <form
        className="dialog" role="dialog" aria-modal="true" aria-labelledby="paste-h"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (text.trim()) onSubmit(text) }}
      >
        <h2 id="paste-h">Paste Markdown</h2>
        <p>It's rendered right here in your browser and isn't sent anywhere.</p>
        <textarea
          ref={ref} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
          placeholder={'---\ntitle: My note\n---\n\n# Hello'}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) onSubmit(text) }}
        />
        <div className="dialog-actions">
          <span className="hint hide-sm">Ctrl+Enter to view</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!text.trim()}>View</button>
        </div>
      </form>
    </div>
  )
}
