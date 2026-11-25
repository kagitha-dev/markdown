import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { docStats, extractFrontmatter } from './frontmatter'
import { FrontmatterCard } from './frontmatter-card'
import { FolderPanel, RecentPanel } from './side-panels'
import { addRecent, clearRecent, listRecent, removeRecent, touchFolderPath, type RecentEntry } from './recent'
import type { SearchIndex } from './search'
import {
  assetUrl, canPickDirectory, ensurePermission, findFile, fromDirectoryHandle, fromDroppedEntry, fromFileList,
  isMarkdownName, pickDirectory, releaseWorkspace, resolvePath, startFile, type Workspace,
} from './workspace'
import { SAMPLE, SAMPLE_NAME } from './sample'
import { Icon } from './icons'
import { baseName, buildStandaloneHtml, copyRich, downloadBlob, escapeHtml, metaHtml } from './export'
import { ExportMenu } from './export-menu'

type Theme = 'system' | 'light' | 'dark'
type View = 'preview' | 'source'
interface Doc { name: string; text: string; /** path inside the opened folder */ path?: string }
/** History entries for opened files. depth counts entries since home; ws + path identify a file in a folder. */
interface HistState { kmvFile: true; depth: number; ws?: number; path?: string }

/* The Markdown pipeline (unified, Shiki, KaTeX) is the largest part of the app, so it loads separately. */
const md = () => import('./markdown')
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
    try {
      const { svg } = await mermaid.render('mmd-' + ++mermaidSeq, src)
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
  const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 20
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  pane.scrollTo({ top, behavior: smooth && !reduce ? 'smooth' : 'auto' })
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

/** Images with relative paths are read from the opened folder; without one, a note explains why they're missing. */
function showLocalImages(root: HTMLElement, ws: Workspace | null, docPath: string | undefined) {
  root.querySelectorAll<HTMLImageElement>('img[data-local-src]').forEach((img) => {
    const src = img.dataset.localSrc ?? ''
    const target = ws && docPath !== undefined ? resolvePath(docPath, src) : null
    const file = ws && target !== null ? findFile(ws, target) : null
    if (ws && file) {
      assetUrl(ws, file).then((u) => { if (img.isConnected) img.src = u }, () => missing(img, src, 'could not be read'))
    } else missing(img, src, ws ? 'is not in this folder' : 'opens with its folder')
  })
}
function missing(img: HTMLImageElement, src: string, why: string) {
  const box = document.createElement('span')
  box.className = 'img-missing'
  box.title = src
  const label = document.createElement('strong')
  label.textContent = img.alt || src.split('/').pop() || 'Image'
  const note = document.createElement('span')
  note.textContent = `${src} ${why}`
  box.append(label, note)
  img.replaceWith(box)
}

/* ---------- App ---------- */
export default function App() {
  const [doc, setDoc] = useState<Doc>(() => store.get<Doc>('kmv.doc', { name: SAMPLE_NAME, text: SAMPLE }))
  const [theme, setTheme] = useState<Theme>(() => store.get<Theme>('kmv.theme', 'system'))
  const [view, setView] = useState<View>('preview')
  const [html, setHtml] = useState('')
  const [srcHtml, setSrcHtml] = useState('')
  const [rendering, setRendering] = useState(true)
  const [toc, setToc] = useState<TocItem[]>([])
  const [activeId, setActiveId] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [toast, setToast] = useState<{ msg: string; undo?: Doc } | null>(null)
  const [includeFm, setIncludeFm] = useState(() => store.get<boolean>('kmv.exportFm', true))
  const [busy, setBusy] = useState(false)
  const [ws, setWs] = useState<Workspace | null>(null)
  const [index, setIndex] = useState<SearchIndex | null>(null)
  const [indexing, setIndexing] = useState<{ done: number; total: number } | null>(null)
  const [query, setQuery] = useState('')
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const [installPrompt, setInstallPrompt] = useState<any>(null)

  const dark = useResolvedDark(theme)
  const articleRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const wsRef = useRef(ws)
  wsRef.current = ws
  /** What to do once the next document has rendered: jump to a heading, or highlight search words. */
  const pendingRef = useRef<{ hash?: string; terms?: string[] } | null>(null)

  const fm = useMemo(() => extractFrontmatter(doc.text), [doc.text])
  const stats = useMemo(() => docStats(doc.text), [doc.text])
  const title = (typeof fm?.data?.title === 'string' && fm.data.title) || doc.name

  /* theme class + persistence */
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    store.set('kmv.theme', theme)
  }, [dark, theme])
  useEffect(() => { if (doc.text.length < MAX_SAVE) store.set('kmv.doc', doc) }, [doc])
  useEffect(() => { document.title = `${title} · kagitha Markdown Viewer` }, [title])

  /* render markdown (debounced) */
  useEffect(() => {
    let live = true
    setRendering(true)
    const t = setTimeout(async () => {
      try {
        const out = await (await md()).renderMarkdown(doc.text)
        if (live) setHtml(out)
      } catch (e) {
        if (live) setHtml(`<p class="render-error">Could not render this file: ${escapeHtml(String(e))}</p>`)
      } finally { if (live) setRendering(false) }
    }, 60)
    return () => { live = false; clearTimeout(t) }
  }, [doc.text])

  useEffect(() => {
    if (view !== 'source') return
    let live = true
    md().then((m) => m.highlightSource(doc.text)).then((h) => live && setSrcHtml(h))
    return () => { live = false }
  }, [view, doc.text])

  /* after the article html changes: TOC, copy buttons, diagrams */
  useEffect(() => {
    const el = articleRef.current
    if (!el || view !== 'preview') return
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
    showLocalImages(el, wsRef.current, docRef.current.path)
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending?.hash) scrollPaneTo(mainRef.current, findAnchor(pending.hash), false)
    else if (pending?.terms?.length) scrollPaneTo(mainRef.current, markTerms(el, pending.terms), false)
    renderMermaid(el, dark)
  }, [html, view]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const update = () => {
      frame = 0
      const limit = root.getBoundingClientRect().top + root.clientHeight * 0.25
      let current = toc[0].id
      for (const t of toc) {
        const h = document.getElementById(t.id)
        if (h && h.getBoundingClientRect().top <= limit) current = t.id
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = toc[toc.length - 1].id
      setActiveId(current)
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => { root.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame) }
  }, [toc])

  /* clicks inside the article: copy buttons, in-page links */
  const onArticleClick = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement
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
  const isHome = doc.name === SAMPLE_NAME && doc.text === SAMPLE && !doc.path
  const lastFileRef = useRef<Doc | null>(isHome ? null : doc)

  const showDoc = useCallback((next: Doc) => {
    setDoc(next)
    setView('preview')
    setDrawer(false)
    mainRef.current?.scrollTo({ top: 0 })
  }, [])

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
    setToast({ msg, undo: docRef.current })
    record(next, 'replace')
    showDoc(next)
  }, [record, showDoc])

  const goHome = useCallback(() => {
    if (docRef.current.name === SAMPLE_NAME && docRef.current.text === SAMPLE && !docRef.current.path) {
      mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setToast(null)
    try { const st = histState(); if (st) { history.go(-st.depth); return } } catch { /* fall through */ }
    showDoc({ name: SAMPLE_NAME, text: SAMPLE })
  }, [showDoc])

  /** Open a file from the opened folder. */
  const openPath = useCallback(async (path: string, opts: { history?: 'push' | 'replace' | 'none'; hash?: string; terms?: string[]; force?: boolean } = {}) => {
    const w = wsRef.current
    const f = w?.files.get(path)
    if (!w || !f) return false
    if (path === docRef.current.path && opts.history !== 'none' && !opts.force) {
      setDrawer(false)
      if (opts.hash) scrollPaneTo(mainRef.current, findAnchor(opts.hash))
      else if (opts.terms?.length && articleRef.current) {
        clearMarks(articleRef.current)
        scrollPaneTo(mainRef.current, markTerms(articleRef.current, opts.terms))
      }
      return true
    }
    let text: string
    try {
      const file = await f.get()
      if (file.size > 10_000_000) { setToast({ msg: `${f.name} is over 10 MB, which is too large to preview.` }); return false }
      text = await file.text()
    } catch {
      setToast({ msg: `Could not read ${path}. It may have been moved or deleted.` })
      return false
    }
    const next: Doc = { name: f.name, text, path }
    pendingRef.current = opts.hash || opts.terms ? { hash: opts.hash, terms: opts.terms } : null
    if (opts.history !== 'none') record(next, opts.history ?? 'push')
    else lastFileRef.current = next
    showDoc(next)
    if (w.handle) touchFolderPath(w.handle, path)
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
    const target = resolvePath(from, href)
    if (target === null) { setToast({ msg: `${href} is outside the opened folder.` }); return }
    const f = findFile(w, target)
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
    setWs(null); setIndex(null); setIndexing(null); setQuery('')
  }, [])

  const readFile = useCallback(async (f: File | Blob & { name: string }) => {
    const isText = isMarkdownName(f.name) || f.type.startsWith('text/')
    if (!isText) { setToast({ msg: `${f.name} isn't a Markdown or text file.` }); return }
    if (f.size > 10_000_000) { setToast({ msg: `${f.name} is over 10 MB, which is too large to preview.` }); return }
    const text = await f.text()
    closeFolder()
    replaceDoc({ name: f.name, text }, `Opened ${f.name}`)
    addRecent({ kind: 'file', name: f.name, text }).then(setRecent)
  }, [replaceDoc, closeFolder])

  /** Show an opened folder: its first file, the file tree, and a search index built in the background. */
  const indexJob = useRef<{ cancelled: boolean } | null>(null)
  const loadWorkspace = useCallback(async (w: Workspace | null, start?: string) => {
    if (!w) return
    if (!w.docs.length) { setToast({ msg: `There are no Markdown files in ${w.name}.` }); return }
    const old = wsRef.current
    if (old && old !== w) releaseWorkspace(old)
    if (indexJob.current) indexJob.current.cancelled = true
    wsRef.current = w
    setWs(w); setIndex(null); setQuery('')
    const first = start && w.files.has(start) ? start : startFile(w)!
    const prev = docRef.current
    if (await openPath(first, { history: 'replace', force: true })) {
      setToast({ msg: `Opened ${w.name} · ${w.docs.length.toLocaleString()} Markdown file${w.docs.length === 1 ? '' : 's'}`, undo: prev.path ? undefined : prev })
    }
    if (w.handle) addRecent({ kind: 'folder', name: w.name, handle: w.handle, path: first }).then(setRecent)
    const job = { cancelled: false }
    indexJob.current = job
    setIndexing({ done: 0, total: w.docs.length })
    const { buildIndex } = await import('./search')
    const idx = await buildIndex(w, (done, total) => { if (!job.cancelled) setIndexing({ done, total }) }, job)
    if (!job.cancelled) { setIndex(idx); setIndexing(null) }
  }, [openPath])

  const openFolder = useCallback(async () => {
    if (!canPickDirectory) { folderRef.current?.click(); return }
    try {
      const handle = await pickDirectory()
      if (handle) loadWorkspace(await fromDirectoryHandle(handle))
    } catch (e) {
      setToast({ msg: 'Could not open the folder: ' + String((e as Error)?.message ?? e) })
    }
  }, [loadWorkspace])

  const openRecent = useCallback(async (r: RecentEntry) => {
    if (r.kind === 'file') {
      if (r.text === undefined) return
      closeFolder()
      replaceDoc({ name: r.name, text: r.text }, `Opened ${r.name}`)
      addRecent({ kind: 'file', name: r.name, text: r.text }).then(setRecent)
      return
    }
    if (!r.handle) return
    if (!(await ensurePermission(r.handle))) { setToast({ msg: `Access to ${r.name} wasn't allowed.` }); return }
    try { loadWorkspace(await fromDirectoryHandle(r.handle), r.path) }
    catch { setToast({ msg: `Could not open ${r.name}. It may have been moved or deleted.` }); removeRecent(r.id).then(setRecent) }
  }, [closeFolder, replaceDoc, loadWorkspace])

  /* Files opened from the operating system when the app is installed (file handlers). */
  useEffect(() => {
    const lq = (window as any).launchQueue
    lq?.setConsumer?.(async (params: { files?: FileSystemFileHandle[] }) => {
      const h = params.files?.[0]
      if (h) readFile(await h.getFile())
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
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setDragging(true) }
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false) }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault(); depth = 0; setDragging(false)
      const dt = e.dataTransfer
      if (!dt) return
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
      } else if (files[0]) readFile(files[0])
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
  const openFolderRef = useRef<() => void>(() => {})
  openFolderRef.current = openFolder
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openFolderRef.current() }
      else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); fileRef.current?.click() }
      else if (mod && e.key.toLowerCase() === 'k' && wsRef.current) {
        e.preventDefault()
        if (window.matchMedia('(max-width: 900px)').matches) setDrawer(true)
        requestAnimationFrame(() => { const s = document.querySelectorAll<HTMLInputElement>('.search input'); s[s.length - 1]?.focus(); s[s.length - 1]?.select() })
      }
      else if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); exportPdfRef.current() }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'v') { e.preventDefault(); setPasteOpen(true) }
      else if (e.key === 'Escape') { setDrawer(false); setPasteOpen(false) }
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
    if (view !== 'preview') { setView('preview'); await new Promise((r) => setTimeout(r, 350)) }
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

  const recentPanel = !ws && (
    <RecentPanel
      items={recent}
      onOpen={openRecent}
      onRemove={(r) => removeRecent(r.id).then(setRecent)}
      onClear={() => { clearRecent(); setRecent([]) }}
    />
  )
  const sidebar = (
    <>
      {ws && (
        <FolderPanel
          ws={ws} current={doc.path} query={query} onQuery={setQuery} index={index} indexing={indexing}
          searchRef={searchRef} onClose={() => { closeFolder(); if (doc.path) goHome() }}
          onOpen={(path, terms) => openPath(path, { terms })}
        />
      )}
      {isHome && recentPanel}
      <FrontmatterCard fm={fm} />
      <nav className="panel" aria-labelledby="toc-h">
        <h2 id="toc-h" className="panel-h">Outline</h2>
        {toc.length ? (
          <ul className="toc">
            {toc.map((t) => (
              <li key={t.id} className={'toc-l' + t.level}>
                <a
                  href={'#' + t.id}
                  className={t.id === activeId ? 'is-active' : ''}
                  aria-current={t.id === activeId ? 'location' : undefined}
                  onClick={(e) => {
                    e.preventDefault(); setDrawer(false); setView('preview')
                    requestAnimationFrame(() => scrollPaneTo(mainRef.current, document.getElementById(t.id)))
                  }}
                >
                  {t.text}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="panel-empty">No headings yet.</p>
        )}
      </nav>
      {!isHome && recentPanel}
    </>
  )

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <a className="brand-home" href="https://kagitha.com" target="_blank" rel="noopener">kagitha</a>
          <span className="brand-sep" aria-hidden="true">/</span>
          <button type="button" className="brand-name" onClick={goHome} title="Home">Markdown Viewer</button>
        </div>
        <div className="file" title={doc.path && ws ? `${ws.name}/${doc.path}` : doc.name}>
          <span className="file-name">
            {doc.path && ws && <span className="file-dir">{ws.name}/{doc.path.slice(0, doc.path.length - doc.name.length)}</span>}
            {doc.name}
          </span>
          {!isHome && (
            <button type="button" className="file-close" onClick={goHome} title="Close file and go home" aria-label={`Close ${doc.name}`}>
              <Icon name="close" />
            </button>
          )}
        </div>
        <div className="actions">
          <button type="button" className="btn btn--primary" onClick={() => fileRef.current?.click()} title="Open a file (Ctrl+O)">
            <Icon name="file" /><span className="btn-text">Open</span>
          </button>
          <button type="button" className="btn btn--folder" onClick={openFolder} title="Open a folder (Ctrl+Shift+O)">
            <Icon name="folder" /><span className="btn-text">Folder</span>
          </button>
          <button type="button" className="btn" onClick={() => setPasteOpen(true)} title="Paste Markdown (Ctrl+Shift+V)">
            <Icon name="paste" /><span className="btn-text">Paste</span>
          </button>
          <div className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>Preview</button>
            <button type="button" aria-pressed={view === 'source'} onClick={() => setView('source')}>Source</button>
          </div>
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
          ref={fileRef} type="file" hidden accept=".md,.markdown,.mdown,.mkd,.mdx,.txt,text/markdown,text/plain"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = '' }}
        />
        <input
          ref={folderRef} type="file" hidden multiple
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => { const files = e.target.files; if (files?.length) loadWorkspace(fromFileList(files)); e.target.value = '' }}
        />
      </header>

      <div className="body">
        <aside className="side" aria-label="Document details">{sidebar}</aside>

        <div className="main" ref={mainRef}>
          <main className="reading">
            {view === 'preview' && hasFm && (
              <div className="print-meta" dangerouslySetInnerHTML={{ __html: metaHtml(fm!.data) }} />
            )}
            {view === 'preview' ? (
              <article
                ref={articleRef}
                className={'prose' + (rendering && !html ? ' is-loading' : '')}
                onClick={onArticleClick}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ) : (
              <div className="source" dangerouslySetInnerHTML={{ __html: srcHtml }} />
            )}
          </main>
        </div>
      </div>

      <footer className="status">
        <span className="nowrap">{stats.words.toLocaleString()} words</span>
        <span className="nowrap">{stats.minutes} min read</span>
        <span className="hide-sm">{doc.text.split('\n').length.toLocaleString()} lines</span>
        {ws && <span className="hide-sm nowrap">{ws.docs.length.toLocaleString()} files in {ws.name}</span>}
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
            <Icon name="open" />
            <strong>Drop to open</strong>
            <span>a .md file, or a whole folder</span>
          </div>
        </div>
      )}

      {pasteOpen && <PasteDialog onClose={() => setPasteOpen(false)} onSubmit={(text) => { setPasteOpen(false); replaceDoc({ name: 'pasted.md', text }, 'Showing pasted Markdown') }} />}

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
