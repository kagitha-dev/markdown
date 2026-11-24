import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { docStats, extractFrontmatter, highlightSource, renderMarkdown } from './markdown'
import { FrontmatterCard } from './frontmatter-card'
import { SAMPLE, SAMPLE_NAME } from './sample'
import { Icon } from './icons'

type Theme = 'system' | 'light' | 'dark'
type View = 'preview' | 'source'
interface Doc { name: string; text: string }
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

  const dark = useResolvedDark(theme)
  const articleRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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
        const out = await renderMarkdown(doc.text)
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
    highlightSource(doc.text).then((h) => live && setSrcHtml(h))
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
    if (href.startsWith('#')) {
      e.preventDefault()
      const id = decodeURIComponent(href.slice(1))
      const target = document.getElementById(id) ?? document.getElementById('user-content-' + id)
      scrollPaneTo(mainRef.current, target)
    } else if (a && !/^https?:/i.test(href) && !href.startsWith('mailto:')) {
      e.preventDefault()
      setToast({ msg: `Links to other files (${href}) will open once folder support arrives.` })
    }
  }, [])

  /* loading files */
  const docRef = useRef(doc)
  docRef.current = doc
  const isHome = doc.name === SAMPLE_NAME && doc.text === SAMPLE
  const lastFileRef = useRef<Doc | null>(isHome ? null : doc)

  const showDoc = useCallback((next: Doc) => {
    setDoc(next)
    setView('preview')
    setDrawer(false)
    mainRef.current?.scrollTo({ top: 0 })
  }, [])

  /* Opening a file adds one history entry, so the browser's Back button returns home. */
  const replaceDoc = useCallback((next: Doc, msg: string) => {
    setToast({ msg, undo: docRef.current })
    lastFileRef.current = next
    try {
      if (history.state?.kmvFile) history.replaceState({ kmvFile: true }, '')
      else history.pushState({ kmvFile: true }, '')
    } catch { /* history unavailable in some embedded viewers */ }
    showDoc(next)
  }, [showDoc])

  const goHome = useCallback(() => {
    if (docRef.current.name === SAMPLE_NAME && docRef.current.text === SAMPLE) {
      mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setToast(null)
    try { if (history.state?.kmvFile) { history.back(); return } } catch { /* fall through */ }
    showDoc({ name: SAMPLE_NAME, text: SAMPLE })
  }, [showDoc])

  useEffect(() => {
    // A file restored from the last visit still gets a Back-to-home entry.
    try { if (!isHome && !history.state?.kmvFile) history.pushState({ kmvFile: true }, '') } catch { /* ignore */ }
    const onPop = (e: PopStateEvent) => {
      if (e.state?.kmvFile) { if (lastFileRef.current) showDoc(lastFileRef.current) }
      else showDoc({ name: SAMPLE_NAME, text: SAMPLE })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const readFile = useCallback(async (f: File) => {
    const isText = /\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(f.name) || f.type.startsWith('text/')
    if (!isText) { setToast({ msg: `${f.name} isn't a Markdown or text file.` }); return }
    if (f.size > 10_000_000) { setToast({ msg: `${f.name} is over 10 MB, which is too large to preview.` }); return }
    replaceDoc({ name: f.name, text: await f.text() }, `Opened ${f.name}`)
  }, [replaceDoc])

  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setDragging(true) }
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false) }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault(); depth = 0; setDragging(false)
      const f = e.dataTransfer?.files[0]
      if (f) readFile(f)
    }
    window.addEventListener('dragenter', enter); window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave); window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop)
    }
  }, [readFile])

  /* keyboard shortcuts */
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); fileRef.current?.click() }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'v') { e.preventDefault(); setPasteOpen(true) }
      else if (e.key === 'Escape') { setDrawer(false); setPasteOpen(false) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t) }, [toast])

  const cycleTheme = () => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'))
  const themeLabel = theme === 'system' ? 'Theme: system' : theme === 'light' ? 'Theme: light' : 'Theme: dark'

  const downloadHtml = () => {
    const css = Array.from(document.styleSheets)
      .flatMap((sh) => { try { return Array.from(sh.cssRules).map((r) => r.cssText) } catch { return [] } })
      .join('\n')
    const page = `<!DOCTYPE html><html lang="en" class="${dark ? 'dark' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}</style></head><body class="export"><main class="reading"><article class="prose">${articleRef.current?.innerHTML ?? html}</article></main></body></html>`
    const url = URL.createObjectURL(new Blob([page], { type: 'text/html' }))
    const a = document.createElement('a')
    a.href = url; a.download = doc.name.replace(/\.[^.]+$/, '') + '.html'; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  const sidebar = (
    <>
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
        <div className="file" title={doc.name}>
          <span className="file-name">{doc.name}</span>
          {!isHome && (
            <button type="button" className="file-close" onClick={goHome} title="Close file and go home" aria-label={`Close ${doc.name}`}>
              <Icon name="close" />
            </button>
          )}
        </div>
        <div className="actions">
          <button type="button" className="btn btn--primary" onClick={() => fileRef.current?.click()} title="Open a file (Ctrl+O)">
            <Icon name="open" /><span className="btn-text">Open</span>
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
          {isTopWindow && (
            <>
              <button type="button" className="btn btn--icon hide-sm" onClick={() => window.print()} title="Print or save as PDF" aria-label="Print or save as PDF">
                <Icon name="print" />
              </button>
              <button type="button" className="btn btn--icon hide-sm" onClick={downloadHtml} title="Download as HTML" aria-label="Download as HTML">
                <Icon name="download" />
              </button>
            </>
          )}
          <button type="button" className="btn btn--icon show-md" onClick={() => setDrawer(true)} aria-label="Show details and outline">
            <Icon name="panel" />
          </button>
        </div>
        <input
          ref={fileRef} type="file" hidden accept=".md,.markdown,.mdown,.mkd,.mdx,.txt,text/markdown,text/plain"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = '' }}
        />
      </header>

      <div className="body">
        <aside className="side" aria-label="Document details">{sidebar}</aside>

        <div className="main" ref={mainRef}>
          <main className="reading">
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
        <span className="status-right"><span><span className="hide-xs">Opened in your browser · n</span><span className="show-xs">N</span>ever uploaded</span></span>
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
            <span>.md, .markdown or .txt</span>
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

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
