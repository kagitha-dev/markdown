import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './icons'

/** Find in the open document: highlights every match, counts them, and steps through them. */

const MAX = 20000
/** Text that isn't really part of the reading: maths markup, diagrams, code-block bars, heading anchors. */
const SKIP = '.katex, .mermaid-block, .code-bar, .anchor, script, style'
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dt, dd, figcaption, summary, div, section, article'

const HL = 'kmv-find'
const HL_CUR = 'kmv-find-current'
const registry = (): Map<string, unknown> | null => {
  const c = (globalThis as any).CSS
  return c?.highlights && typeof (globalThis as any).Highlight === 'function' ? c.highlights : null
}

interface Seg { node: Text; start: number }

/** All visible text under `root` as one string, with a map back to the text nodes. Blocks are joined by a newline. */
function collect(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  const segs: Seg[] = []
  const parts: string[] = []
  let len = 0
  let lastWs = true
  let prevBlock: Element | null = null
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const data = node.data
    if (!data) continue
    const block = node.parentElement?.closest(BLOCK) ?? root
    if (segs.length && block !== prevBlock && !lastWs) { parts.push('\n'); len++ }
    prevBlock = block
    segs.push({ node, start: len })
    parts.push(data)
    len += data.length
    lastWs = /\s/.test(data[data.length - 1])
  }
  return { text: parts.join(''), segs }
}

/** The text node and offset for a position in the joined string. */
function locate(segs: Seg[], pos: number): [Text, number] {
  let lo = 0, hi = segs.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (segs[mid].start <= pos) lo = mid
    else hi = mid - 1
  }
  const s = segs[lo]
  return [s.node, Math.min(pos - s.start, s.node.data.length - 1)]
}

function search(root: HTMLElement, query: string): { ranges: Range[]; capped: boolean } {
  const q = query.trim()
  if (!q) return { ranges: [], capped: false }
  const { text, segs } = collect(root)
  if (!segs.length) return { ranges: [], capped: false }
  // Any run of spaces in the query also matches line breaks and other whitespace, as browser search does.
  const re = new RegExp(q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gi')
  const ranges: Range[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) { re.lastIndex++; continue }
    const [sn, so] = locate(segs, m.index)
    const [en, eo] = locate(segs, m.index + m[0].length - 1)
    const r = document.createRange()
    r.setStart(sn, so)
    r.setEnd(en, eo + 1)
    ranges.push(r)
    if (ranges.length >= MAX) return { ranges, capped: true }
  }
  return { ranges, capped: false }
}

/* Browsers without the CSS Highlight API get <mark> elements instead. */
function markFallback(ranges: Range[]): HTMLElement[][] {
  const out: HTMLElement[][] = []
  // Wrap from the end so earlier ranges keep their offsets.
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]
    const parts: HTMLElement[] = []
    const nodes: Text[] = []
    const w = document.createTreeWalker(r.commonAncestorContainer, NodeFilter.SHOW_TEXT)
    if (r.commonAncestorContainer.nodeType === Node.TEXT_NODE) nodes.push(r.commonAncestorContainer as Text)
    else while (w.nextNode()) if (r.intersectsNode(w.currentNode)) nodes.push(w.currentNode as Text)
    const sc = r.startContainer, so = r.startOffset, ec = r.endContainer, eo = r.endOffset
    for (const n of nodes.reverse()) {
      const a = n === sc ? so : 0
      const b = n === ec ? eo : n.data.length
      if (a >= b) continue
      const tail = n.splitText(a)
      tail.splitText(b - a)
      const mark = document.createElement('mark')
      mark.className = 'find-mark'
      tail.replaceWith(mark)
      mark.append(tail)
      parts.unshift(mark)
    }
    out[i] = parts
  }
  return out
}
function clearFallback(root: HTMLElement | null) {
  if (!root) return
  const marks = root.querySelectorAll('mark.find-mark')
  if (!marks.length) return
  marks.forEach((m) => m.replaceWith(...Array.from(m.childNodes)))
  root.normalize()
}

/** Bring a match into view inside the reading pane (and inside a wide code block), opening closed <details>. */
function reveal(pane: HTMLElement | null, r: Range) {
  if (!pane) return
  const el = r.startContainer.parentElement
  for (let d = el?.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])'))
    (d as HTMLDetailsElement).open = true
  const box = el?.closest('pre')
  if (box && box.scrollWidth > box.clientWidth) {
    const rr = r.getBoundingClientRect(), br = box.getBoundingClientRect()
    if (rr.left < br.left + 16 || rr.right > br.right - 16) box.scrollLeft += rr.left - br.left - br.width / 3
  }
  // Long pages skip layout for off-screen parts, so positions settle over a few frames: correct until it stays put.
  let tries = 0, still = 0
  const step = () => {
    const rr = r.getBoundingClientRect(), pr = pane.getBoundingClientRect()
    const inView = rr.height > 0 && rr.top >= pr.top + 64 && rr.bottom <= pr.bottom - 32
    if (inView) still++
    else { still = 0; pane.scrollTop += rr.top - pr.top - pr.height * 0.35 }
    if (still < 3 && tries++ < 30) requestAnimationFrame(step)
  }
  step()
}

/** The first match at or below the top of the reading pane, so a new search starts where the reader is. */
function firstInView(pane: HTMLElement | null, ranges: Range[]) {
  if (!pane || ranges.length < 2) return 0
  const top = pane.getBoundingClientRect().top
  let lo = 0, hi = ranges.length - 1
  if (ranges[hi].getBoundingClientRect().bottom < top) return 0
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ranges[mid].getBoundingClientRect().bottom < top) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface FindRequest { n: number; seed?: string }

export function FindBar(props: {
  /** The element holding the document (the article in Preview, the source block in Source). */
  getRoot: () => HTMLElement | null
  pane: React.RefObject<HTMLElement | null>
  /** Changes whenever the document's content is replaced. */
  content: unknown
  request: FindRequest
  big: boolean
  onClose: () => void
  /** Present when a folder is open: search all its files for the same words. */
  onSearchAll?: (q: string) => void
}) {
  const { getRoot, pane, content, request, big, onClose, onSearchAll } = props
  const [query, setQuery] = useState(request.seed ?? '')
  const [found, setFound] = useState<{ ranges: Range[]; capped: boolean }>({ ranges: [], capped: false })
  const [cur, setCur] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const marksRef = useRef<HTMLElement[][]>([])
  const rootRef = useRef<HTMLElement | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  /** Pick the match nearest the reader on the next search (new words or a new page) instead of keeping the current one. */
  const freshRef = useRef(true)
  /** Scroll to that match too: only when the words changed, never just because the page did. */
  const jumpRef = useRef(true)
  const curRef = useRef(cur)
  curRef.current = cur

  /* Focus (and take the selected words) each time the bar is asked for. */
  useEffect(() => {
    if (request.seed) { setQuery(request.seed); freshRef.current = jumpRef.current = true }
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [request])

  const run = useCallback(() => {
    const root = getRoot()
    clearFallback(rootRef.current)
    rootRef.current = root
    const res = root ? search(root, queryRef.current) : { ranges: [], capped: false }
    if (root && !registry() && res.ranges.length) {
      marksRef.current = markFallback(res.ranges)
      // The marks moved the text: rebuild the ranges around them.
      res.ranges = marksRef.current.map((parts) => {
        const r = document.createRange()
        r.setStartBefore(parts[0]); r.setEndAfter(parts[parts.length - 1])
        return r
      })
    } else marksRef.current = []
    let i: number
    if (freshRef.current) {
      i = firstInView(pane.current, res.ranges)
      if (jumpRef.current && res.ranges.length) reveal(pane.current, res.ranges[i])
      freshRef.current = jumpRef.current = false
    }
    else i = Math.min(curRef.current, Math.max(0, res.ranges.length - 1))
    setFound(res)
    setCur(i)
  }, [getRoot, pane])

  /* Search again when the words change (debounced for long documents). */
  useEffect(() => {
    freshRef.current = jumpRef.current = true
    const t = setTimeout(run, big ? 160 : 60)
    return () => clearTimeout(t)
  }, [query, run, big])

  /* ...and when the page changes under it: a new file, the full render replacing the first part,
     code bars and search marks added after rendering. Ignore the bar's own fallback marks. */
  useEffect(() => {
    let t = 0
    freshRef.current = true
    const schedule = () => { clearTimeout(t); t = window.setTimeout(run, 120) }
    schedule()
    const target = pane.current
    if (!target) return () => clearTimeout(t)
    const mo = new MutationObserver((list) => {
      const other = list.some((m) => !(m.target as Element).closest?.('.find-wrap')
        && [...m.addedNodes, ...m.removedNodes].some((n) => n.nodeType === Node.ELEMENT_NODE && !(n as Element).classList.contains('find-mark')))
      if (other) schedule()
    })
    mo.observe(target, { childList: true, subtree: true })
    return () => { clearTimeout(t); mo.disconnect() }
  }, [content, run, pane])

  /* Paint the highlights. */
  useEffect(() => {
    const reg = registry()
    const H = (globalThis as any).Highlight
    if (reg) {
      const all = new H(...found.ranges)
      const one = new H(...(found.ranges[cur] ? [found.ranges[cur]] : []))
      one.priority = 1
      reg.set(HL, all)
      reg.set(HL_CUR, one)
    } else {
      rootRef.current?.querySelectorAll('mark.find-current').forEach((m) => m.classList.remove('find-current'))
      marksRef.current[cur]?.forEach((m) => m.classList.add('find-current'))
    }
  }, [found, cur])

  /* Clean up when the bar closes. */
  useEffect(() => () => {
    const reg = registry()
    reg?.delete(HL); reg?.delete(HL_CUR)
    clearFallback(rootRef.current)
  }, [])

  const go = useCallback((d: number) => {
    const n = found.ranges.length
    if (!n) return
    const i = (cur + d + n) % n
    setCur(i)
    reveal(pane.current, found.ranges[i])
  }, [found, cur, pane])

  const n = found.ranges.length
  const count = !query.trim() ? '' : n ? `${(cur + 1).toLocaleString()} of ${n.toLocaleString()}${found.capped ? '+' : ''}` : 'No results'

  return (
    <div className="find-wrap">
      <div className="find" role="search" aria-label="Find in this file">
        <div className="find-field">
          <Icon name="search" />
          <input
            ref={inputRef} type="text" value={query} placeholder="Find in this file" aria-label="Find in this file"
            spellCheck={false} autoComplete="off" enterKeyHint="search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'F3') { e.preventDefault(); go(e.shiftKey ? -1 : 1) }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
            }}
          />
          <span className={'find-count' + (query.trim() && !n ? ' is-none' : '')} aria-live="polite">{count}</span>
        </div>
        <button type="button" className="find-btn find-prev" onClick={() => go(-1)} disabled={n < 1} title="Previous match (Shift+Enter)" aria-label="Previous match">
          <Icon name="chevron" />
        </button>
        <button type="button" className="find-btn" onClick={() => go(1)} disabled={n < 1} title="Next match (Enter)" aria-label="Next match">
          <Icon name="chevron" />
        </button>
        {onSearchAll && (
          <button type="button" className="find-all" onClick={() => onSearchAll(query.trim())} title="Search every file in the folder (Ctrl+K)">
            All files
          </button>
        )}
        <button type="button" className="find-btn" onClick={onClose} title="Close (Esc)" aria-label="Close find">
          <Icon name="close" />
        </button>
      </div>
    </div>
  )
}
