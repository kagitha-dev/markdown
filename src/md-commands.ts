/*
 * Markdown editing commands for the editor (headings, lists, tables, blocks and so on).
 * Each one changes the Markdown text at the cursor and returns false when it doesn't apply.
 */
import { EditorSelection, type EditorState, type Line, type SelectionRange, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export type Cmd = (view: EditorView) => boolean

const run = (view: EditorView, spec: TransactionSpec) => {
  view.dispatch({ scrollIntoView: true, userEvent: 'input.format', ...spec })
  view.focus()
  return true
}

/* ---------- inline formatting ---------- */

/** Wrap the selection (or the word at the cursor) in markers, or remove them if they're already there. */
export function toggleWrap(open: string, close = open, placeholder = 'text'): Cmd {
  return (view) => {
    const { state } = view
    const single = open.length === 1 && close === open
    const markerAt = (pos: number, m: string) => state.sliceDoc(pos, pos + m.length) === m
    const tx = state.changeByRange((r) => {
      let { from, to } = r
      if (r.empty) {
        const w = state.wordAt(r.head)
        if (w) { from = w.from; to = w.to }
      }
      const text = state.sliceDoc(from, to)
      // Markers just outside the selection: **|bold|**
      let outside = from !== to && markerAt(from - open.length, open) && markerAt(to, close)
      if (outside && single) {
        // "*" for italic must not be one half of "**" bold: an odd run (* or ***) means italic is on.
        let left = 0, right = 0
        while (state.sliceDoc(from - left - 1, from - left) === open) left++
        while (state.sliceDoc(to + right, to + right + 1) === open) right++
        outside = left % 2 === 1 && right % 2 === 1
      }
      if (outside) {
        return {
          changes: [{ from: from - open.length, to: from }, { from: to, to: to + close.length }],
          range: EditorSelection.range(r.anchor - open.length, r.head - open.length),
        }
      }
      // Markers inside the selection: |**bold**|
      if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
        const inner = text.slice(open.length, text.length - close.length)
        return { changes: { from, to, insert: inner }, range: EditorSelection.range(from, from + inner.length) }
      }
      if (from === to) {
        const insert = open + placeholder + close
        return { changes: { from, insert }, range: EditorSelection.range(from + open.length, from + open.length + placeholder.length) }
      }
      const shift = open.length
      return {
        changes: [{ from, insert: open }, { from: to, insert: close }],
        range: r.empty ? EditorSelection.cursor(r.head + shift) : EditorSelection.range(r.anchor + shift, r.head + shift),
      }
    })
    return run(view, tx)
  }
}

/** Remove inline Markdown from the selection: emphasis, code, strikethrough and links. */
export const clearFormatting: Cmd = (view) => {
  const { state } = view
  if (state.selection.ranges.every((r) => r.empty)) return false
  const tx = state.changeByRange((r) => {
    if (r.empty) return { range: r }
    const text = state.sliceDoc(r.from, r.to)
    const plain = text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/(^|[^\w*])[*_](?!\s)(.+?)[*_](?=[^\w*]|$)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/<\/?(?:b|i|em|strong|u|s|del|ins|mark|sup|sub|code)>/gi, '')
    return { changes: { from: r.from, to: r.to, insert: plain }, range: EditorSelection.range(r.from, r.from + plain.length) }
  })
  return run(view, tx)
}

/* ---------- line helpers ---------- */

function selectedLines(state: EditorState): Line[] {
  const seen = new Set<number>()
  const out: Line[] = []
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    // A selection ending at the very start of a line doesn't include that line.
    let last = state.doc.lineAt(r.to).number
    if (r.to > r.from && state.doc.lineAt(r.to).from === r.to && last > first) last--
    for (let n = first; n <= last; n++) if (!seen.has(n)) { seen.add(n); out.push(state.doc.line(n)) }
  }
  return out
}

/** Replace each selected line's text with fn(text); keeps the cursor at the same place in the content. */
function mapLines(view: EditorView, fn: (text: string, i: number, line: Line) => string | null): boolean {
  const { state } = view
  const lines = selectedLines(state)
  const changes: { from: number; to: number; insert: string }[] = []
  lines.forEach((line, i) => {
    const next = fn(line.text, i, line)
    if (next !== null && next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
  })
  if (!changes.length) { view.focus(); return true }
  const set = state.changes(changes)
  // Keep each cursor next to the same text; a cursor at the start of an edited line goes after the new marker.
  const sel = EditorSelection.create(state.selection.ranges.map((r) => {
    const map = (pos: number, assoc: -1 | 1) => {
      const line = state.doc.lineAt(pos)
      const ch = changes.find((c) => c.from === line.from)
      if (!ch) return set.mapPos(pos, assoc)
      const oldMarker = markerLen(line.text)
      const newMarker = markerLen(ch.insert)
      const offset = Math.max(0, pos - line.from - oldMarker)
      return set.mapPos(line.from) + Math.min(ch.insert.length, newMarker + offset)
    }
    return EditorSelection.range(map(r.anchor, -1), map(r.head, 1))
  }), state.selection.mainIndex)
  return run(view, { changes: set, selection: sel })
}

const HEADING = /^(\s{0,3})(#{1,6})(\s+|$)/
const LIST = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/
const QUOTE = /^(\s*)(>\s?)+/
/** Length of the block marker at the start of a line (heading, list, quote), with its indentation. */
function markerLen(text: string): number {
  const m = HEADING.exec(text) ?? LIST.exec(text) ?? QUOTE.exec(text)
  return m ? m[0].length : 0
}

/* ---------- headings ---------- */

export function headingLevel(text: string) {
  const m = HEADING.exec(text)
  return m ? m[2].length : 0
}

function stripBlock(text: string) {
  return text.replace(HEADING, '$1').replace(LIST, '$1')
}

/** Make the selected lines a heading of `level` (0 = paragraph). Running it again on a heading of that level makes it a paragraph. */
export function setHeading(level: number): Cmd {
  return (view) => {
    const lines = selectedLines(view.state)
    const all = level > 0 && lines.every((l) => !l.text.trim() || headingLevel(l.text) === level)
    return mapLines(view, (text) => {
      if (!text.trim() && lines.length > 1) return null
      const bare = stripBlock(text).trimStart()
      if (level === 0 || all) return bare
      return '#'.repeat(level) + ' ' + bare
    })
  }
}

/** Increase (H3 → H2, paragraph → H6) or decrease (H2 → H3, H6 → paragraph) the heading level. */
export function shiftHeading(dir: 1 | -1): Cmd {
  return (view) => mapLines(view, (text) => {
    if (!text.trim()) return null
    const cur = headingLevel(text)
    const bare = stripBlock(text).trimStart()
    let next = cur
    if (dir === 1) next = cur === 0 ? 6 : Math.max(1, cur - 1)
    else next = cur === 0 ? 0 : cur === 6 ? 0 : cur + 1
    return next ? '#'.repeat(next) + ' ' + bare : bare
  })
}

/* ---------- lists and quotes ---------- */

type ListKind = 'ul' | 'ol' | 'task'
const kindOf = (text: string): ListKind | null => {
  const m = LIST.exec(text)
  if (!m) return null
  if (/\[[ xX]\]/.test(m[2])) return 'task'
  return /^\d/.test(m[2]) ? 'ol' : 'ul'
}

export function toggleList(kind: ListKind): Cmd {
  return (view) => {
    const lines = selectedLines(view.state)
    const content = lines.filter((l) => l.text.trim())
    const remove = content.length > 0 && content.every((l) => kindOf(l.text) === kind)
    let n = 0
    return mapLines(view, (text) => {
      if (!text.trim() && lines.length > 1) return null
      const indent = /^\s*/.exec(text)![0]
      const bare = text.replace(HEADING, '').replace(LIST, '').replace(/^\s+/, '')
      if (remove) return indent + bare
      const marker = kind === 'ul' ? '- ' : kind === 'task' ? '- [ ] ' : `${++n}. `
      return indent + marker + bare
    })
  }
}

export const toggleTaskDone: Cmd = (view) => {
  const lines = selectedLines(view.state).filter((l) => /^\s*[-*+]\s+\[[ xX]\]/.test(l.text))
  if (!lines.length) return false
  const done = lines.every((l) => /^\s*[-*+]\s+\[[xX]\]/.test(l.text))
  return mapLines(view, (text) => /^\s*[-*+]\s+\[[ xX]\]/.test(text) ? text.replace(/\[[ xX]\]/, done ? '[ ]' : '[x]') : null)
}

export const toggleQuote: Cmd = (view) => {
  const lines = selectedLines(view.state)
  const content = lines.filter((l) => l.text.trim())
  const remove = content.length > 0 && content.every((l) => /^\s*>/.test(l.text))
  return mapLines(view, (text) => {
    if (remove) return text.replace(/^(\s*)>\s?/, '$1')
    return text.trim() ? '> ' + text : '>'
  })
}

/** GitHub alert: > [!NOTE] */
export function alert(kind: string): Cmd {
  return (view) => {
    const { state } = view
    const r = state.selection.main
    const head = `> [!${kind.toUpperCase()}]`
    if (!r.empty) {
      const lines = selectedLines(state)
      const from = lines[0].from, to = lines[lines.length - 1].to
      const body = lines.map((l) => (l.text.trim() ? '> ' + l.text : '>')).join('\n')
      const insert = head + '\n' + body
      return run(view, { changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length) })
    }
    return insertBlock(view, head + '\n> ', [head.length + 3, head.length + 3])
  }
}

/* ---------- blocks ---------- */

/**
 * Insert a block of Markdown on its own lines, with blank lines around it.
 * `sel` is the selection to make, as offsets inside `block`.
 */
export function insertBlock(view: EditorView, block: string, sel?: [number, number]): boolean {
  const { state } = view
  const r = state.selection.main
  const line = state.doc.lineAt(r.head)
  let from: number, to: number, prefix = ''
  if (!line.text.trim()) {
    from = line.from; to = line.to
    const prev = line.number > 1 ? state.doc.line(line.number - 1).text : ''
    if (prev.trim()) prefix = '\n'
  } else {
    from = to = line.to
    prefix = '\n\n'
  }
  const nextNo = line.number + 1
  const next = nextNo <= state.doc.lines ? state.doc.line(nextNo).text : null
  const suffix = next === null || next.trim() ? '\n' : ''
  const insert = prefix + block + suffix
  const start = from + prefix.length
  const [a, b] = sel ?? [block.length, block.length]
  return run(view, { changes: { from, to, insert }, selection: EditorSelection.range(start + a, start + b) })
}

/** Insert text at the cursor and select part of it (offsets inside `text`). */
function insertInline(view: EditorView, text: string, sel?: [number, number]): boolean {
  const r = view.state.selection.main
  const [a, b] = sel ?? [text.length, text.length]
  return run(view, { changes: { from: r.from, to: r.to, insert: text }, selection: EditorSelection.range(r.from + a, r.from + b) })
}

/** Wrap the selected lines in fences, or insert an empty fenced block. */
function fenced(open: string, close: string, placeholder = ''): Cmd {
  return (view) => {
    const { state } = view
    const r = state.selection.main
    if (!r.empty) {
      const lines = selectedLines(state)
      const from = lines[0].from, to = lines[lines.length - 1].to
      const inner = state.sliceDoc(from, to)
      const insert = `${open}\n${inner}\n${close}`
      const before = from > 0 && state.doc.lineAt(from - 1).text.trim() ? '\n' : ''
      return run(view, {
        changes: { from, to, insert: before + insert },
        selection: EditorSelection.cursor(from + before.length + open.length),
      })
    }
    const block = `${open}\n${placeholder}\n${close}`
    return insertBlock(view, block, [open.length + 1, open.length + 1 + placeholder.length])
  }
}

export const codeBlock: Cmd = (view) => {
  const r = view.state.selection.main
  if (r.empty) return insertBlock(view, '```\n\n```', [3, 3]) // cursor after ``` to type the language
  return fenced('```', '```')(view)
}
export const mathBlock = fenced('$$', '$$')
export const mermaid: Cmd = (view) => {
  const body = 'flowchart LR\n  A[Start] --> B{Choice}\n  B -->|Yes| C[Done]\n  B -->|No| A'
  return insertBlock(view, '```mermaid\n' + body + '\n```', [11, 11 + body.length])
}
export const details: Cmd = (view) => {
  const block = '<details>\n<summary>Summary</summary>\n\nHidden content.\n\n</details>'
  const s = block.indexOf('Summary<')
  return insertBlock(view, block, [s, s + 7])
}
export const hr: Cmd = (view) => insertBlock(view, '---')

export const paragraphAfter: Cmd = (view) => {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  return run(view, { changes: { from: line.to, insert: '\n\n' }, selection: EditorSelection.cursor(line.to + 2) })
}
export const paragraphBefore: Cmd = (view) => {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  return run(view, { changes: { from: line.from, insert: '\n\n' }, selection: EditorSelection.cursor(line.from) })
}

/* ---------- links, images, footnotes ---------- */

const URL_RE = /^(https?:\/\/|mailto:|www\.)\S+$/i

export const link: Cmd = (view) => {
  const { state } = view
  const r = state.selection.main
  const text = state.sliceDoc(r.from, r.to)
  if (text && URL_RE.test(text.trim())) {
    const url = text.trim()
    return insertInline(view, `[link text](${url})`, [1, 10])
  }
  if (text) {
    const md = `[${text}](url)`
    return insertInline(view, md, [text.length + 3, text.length + 6])
  }
  return insertInline(view, '[link text](url)', [1, 10])
}

export const image: Cmd = (view) => {
  const { state } = view
  const r = state.selection.main
  const text = state.sliceDoc(r.from, r.to)
  if (text && /\.(png|jpe?g|gif|webp|svg|avif)$|^https?:/i.test(text.trim())) return insertInline(view, `![description](${text.trim()})`, [2, 13])
  const alt = text || 'description'
  const md = `![${alt}](image.png)`
  return insertInline(view, md, text ? [alt.length + 4, alt.length + 13] : [2, 2 + alt.length])
}

/** Append a definition at the end of the document (after a blank line) and return its position. */
function appendDefinition(state: EditorState, def: string) {
  const end = state.doc.length
  const text = state.doc.toString()
  const sep = !text ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return { from: end, insert: sep + def + '\n', at: end + sep.length + def.length }
}

export const footnote: Cmd = (view) => {
  const { state } = view
  const used = [...state.doc.toString().matchAll(/\[\^(\d+)\]/g)].map((m) => +m[1])
  const n = used.length ? Math.max(...used) + 1 : 1
  const r = state.selection.main
  const ref = `[^${n}]`
  const def = appendDefinition(state, `[^${n}]: `)
  return run(view, {
    changes: [{ from: r.to, insert: ref }, { from: def.from, insert: def.insert }],
    selection: EditorSelection.cursor(def.at + ref.length),
  })
}

export const linkReference: Cmd = (view) => {
  const { state } = view
  const r = state.selection.main
  const text = state.sliceDoc(r.from, r.to) || 'link text'
  const used = new Set([...state.doc.toString().matchAll(/^\s{0,3}\[([^\]^][^\]]*)\]:/gm)].map((m) => m[1].toLowerCase()))
  let n = 1
  while (used.has(String(n))) n++
  const def = appendDefinition(state, `[${n}]: https://`)
  return run(view, {
    changes: [{ from: r.from, to: r.to, insert: `[${text}][${n}]` }, { from: def.from, insert: def.insert }],
    selection: EditorSelection.range(def.at - 8, def.at + `[${text}][${n}]`.length - (r.to - r.from)),
  })
}

export const inlineMath = toggleWrap('$', '$', 'x^2')

export const date: Cmd = (view) => {
  const d = new Date()
  const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return insertInline(view, s)
}

/* ---------- front matter and table of contents ---------- */

export function frontMatter(fields: string): Cmd {
  return (view) => {
    const { state } = view
    const text = state.doc.toString()
    if (/^---\r?\n/.test(text)) {
      // Already there: put the cursor at the end of it.
      const end = text.indexOf('\n---', 3)
      return run(view, { selection: EditorSelection.cursor(end > 0 ? end : 4) })
    }
    const block = `---\n${fields}\n---\n` + (text && !text.startsWith('\n') ? '\n' : '')
    const firstVal = block.indexOf(': ') + 2
    const lineEnd = block.indexOf('\n', firstVal)
    return run(view, { changes: { from: 0, insert: block }, selection: EditorSelection.range(firstVal, lineEnd) })
  }
}

/** A slug as GitHub (and rehype-slug) makes them. */
function slug(text: string, seen: Map<string, number>) {
  const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-')
  const n = seen.get(base) ?? 0
  seen.set(base, n + 1)
  return n ? `${base}-${n}` : base
}

/** A list of links to the document's headings (H2 and H3; H1 too if there's more than one). */
export const tableOfContents: Cmd = (view) => {
  const text = view.state.doc.toString()
  const heads: { level: number; text: string }[] = []
  let fence = ''
  const lines = text.split('\n')
  let i = 0
  if (/^---\s*$/.test(lines[0] ?? '')) { i = 1; while (i < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[i])) i++; i++ }
  for (; i < lines.length; i++) {
    const l = lines[i]
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l)
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = ''; continue }
    if (fence) continue
    const m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l)
    if (m) heads.push({ level: m[1].length, text: m[2].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '') })
  }
  const seen = new Map<string, number>()
  const withIds = heads.map((h) => ({ ...h, id: slug(h.text, seen) }))
  const h1s = heads.filter((h) => h.level === 1).length
  const top = h1s > 1 ? 1 : 2
  const items = withIds.filter((h) => h.level >= top && h.level <= top + 1)
  if (!items.length) return insertBlock(view, '<!-- Add headings (## Section) and run Insert → Table of contents again -->')
  const block = items.map((h) => `${'  '.repeat(h.level - top)}- [${h.text}](#${h.id})`).join('\n')
  return insertBlock(view, block)
}

/* ---------- tables ---------- */

export function insertTable(cols: number, rows: number): Cmd {
  return (view) => {
    const header = Array.from({ length: cols }, (_, i) => `Column ${i + 1}`)
    const lines = [header, header.map(() => '---'), ...Array.from({ length: rows - 1 }, () => header.map(() => ''))]
    const out = formatTable(lines, header.map(() => ''))
    return insertBlock(view, out.join('\n'), [2, 2 + header[0].length])
  }
}

type Align = '' | 'left' | 'center' | 'right'
interface TableAt { from: number; to: number; first: number; rows: string[][]; aligns: Align[]; row: number; col: number }

const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function splitRow(text: string): string[] {
  let s = text.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = '', code = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; continue }
    if (c === '`') code = !code
    if (c === '|' && !code) { cells.push(cur.trim()); cur = '' } else cur += c
  }
  cells.push(cur.trim())
  return cells
}

/** The column the cursor is in: unescaped pipes before it on the line. */
function colAt(text: string, offset: number): number {
  const before = text.slice(0, offset)
  const pipes = (before.match(/(?<!\\)\|/g) ?? []).length
  return Math.max(0, pipes - (text.trimStart().startsWith('|') ? 1 : 0))
}

function tableAt(state: EditorState): TableAt | null {
  const pos = state.selection.main.head
  const cur = state.doc.lineAt(pos)
  if (!cur.text.includes('|')) return null
  let first = cur.number, last = cur.number
  while (first > 1 && state.doc.line(first - 1).text.includes('|') && state.doc.line(first - 1).text.trim()) first--
  while (last < state.doc.lines && state.doc.line(last + 1).text.includes('|') && state.doc.line(last + 1).text.trim()) last++
  // The header is the line just above the first delimiter row.
  let delim = -1
  for (let n = first; n <= last; n++) if (DELIM.test(state.doc.line(n).text) && n > first) { delim = n; break }
  if (delim < 0) return null
  first = delim - 1
  if (cur.number < first) return null
  const texts: string[] = []
  for (let n = first; n <= last; n++) texts.push(state.doc.line(n).text)
  const aligns: Align[] = splitRow(texts[1]).map((c) => {
    const l = c.startsWith(':'), r = c.endsWith(':')
    return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
  })
  const width = aligns.length
  const rows = texts.map((t, i) => {
    if (i === 1) return aligns.map(() => '---')
    const cells = splitRow(t)
    while (cells.length < width) cells.push('')
    return cells
  })
  const cols = Math.max(width, ...rows.map((r) => r.length))
  rows.forEach((r) => { while (r.length < cols) r.push('') })
  while (aligns.length < cols) aligns.push('')
  return {
    from: state.doc.line(first).from, to: state.doc.line(last).to, first, rows, aligns,
    row: cur.number - first, col: Math.min(cols - 1, colAt(cur.text, pos - cur.from)),
  }
}

const cellWidth = (s: string) => [...s].length

function formatTable(rows: string[][], aligns: Align[]): string[] {
  const cols = aligns.length
  const w = Array.from({ length: cols }, (_, c) => Math.max(3, ...rows.map((r, i) => (i === 1 ? 3 : cellWidth(r[c] ?? '')))))
  return rows.map((r, i) => {
    if (i === 1) {
      return '| ' + aligns.map((a, c) => {
        const n = w[c]
        if (a === 'center') return ':' + '-'.repeat(n - 2) + ':'
        if (a === 'right') return '-'.repeat(n - 1) + ':'
        if (a === 'left') return ':' + '-'.repeat(n - 1)
        return '-'.repeat(n)
      }).join(' | ') + ' |'
    }
    return '| ' + r.map((cell, c) => {
      const pad = w[c] - cellWidth(cell)
      if (aligns[c] === 'right') return ' '.repeat(pad) + cell
      if (aligns[c] === 'center') return ' '.repeat(Math.floor(pad / 2)) + cell + ' '.repeat(Math.ceil(pad / 2))
      return cell + ' '.repeat(pad)
    }).join(' | ') + ' |'
  })
}

/** Rewrite the table at the cursor with `edit`, then put the cursor in cell (row, col). */
function editTable(edit: (t: TableAt) => { row: number; col: number } | false): Cmd {
  return (view) => {
    const t = tableAt(view.state)
    if (!t) return false
    const target = edit(t)
    if (!target) return false
    const lines = formatTable(t.rows, t.aligns)
    const text = lines.join('\n')
    const row = Math.max(0, Math.min(lines.length - 1, target.row))
    const col = Math.max(0, Math.min(t.aligns.length - 1, target.col))
    let offset = lines.slice(0, row).reduce((n, l) => n + l.length + 1, 0)
    // Select the target cell's text (or put the cursor in it when it's empty).
    const line = lines[row]
    let pipes = 0, i = 0
    for (; i < line.length; i++) { if (line[i] === '|' && line[i - 1] !== '\\') { if (pipes === col) break; pipes++ } }
    const start = Math.min(line.length, i + 2)
    const cell = row === 1 ? '' : (t.rows[row]?.[col] ?? '')
    const lead = cell && (t.aligns[col] === 'right' || t.aligns[col] === 'center') ? line.slice(start).search(/\S|$/) : 0
    const a = t.from + offset + start + Math.max(0, Math.min(lead, line.length - start))
    return run(view, { changes: { from: t.from, to: t.to, insert: text }, selection: EditorSelection.range(a, a + cell.length) })
  }
}

const blankRow = (t: TableAt) => t.aligns.map(() => '')
export const tableRowBelow = editTable((t) => {
  const at = t.row <= 1 ? 2 : t.row + 1
  t.rows.splice(at, 0, blankRow(t))
  return { row: at, col: t.col }
})
export const tableRowAbove = editTable((t) => {
  const at = t.row <= 1 ? 2 : t.row
  t.rows.splice(at, 0, blankRow(t))
  return { row: at, col: t.col }
})
export const tableDeleteRow = editTable((t) => {
  if (t.row <= 1) return false // the header and delimiter rows stay
  t.rows.splice(t.row, 1)
  return { row: Math.min(t.row, t.rows.length - 1), col: t.col }
})
function addColumn(right: boolean) {
  return editTable((t) => {
    const at = right ? t.col + 1 : t.col
    t.rows.forEach((r, i) => r.splice(at, 0, i === 0 ? `Column ${t.aligns.length + 1}` : i === 1 ? '---' : ''))
    t.aligns.splice(at, 0, '')
    return { row: 0, col: at }
  })
}
export const tableColumnRight = addColumn(true)
export const tableColumnLeft = addColumn(false)
export const tableDeleteColumn = editTable((t) => {
  if (t.aligns.length <= 1) return false
  t.rows.forEach((r) => r.splice(t.col, 1))
  t.aligns.splice(t.col, 1)
  return { row: t.row, col: Math.min(t.col, t.aligns.length - 1) }
})
export function tableAlign(a: Align): Cmd {
  return editTable((t) => { t.aligns[t.col] = t.aligns[t.col] === a ? '' : a; return { row: t.row, col: t.col } })
}
export const tableFormat = editTable((t) => ({ row: t.row, col: t.col }))

/** Tab and Shift-Tab move between table cells (adding a row after the last one); outside a table they do nothing. */
export function tableTab(dir: 1 | -1): Cmd {
  return (view) => {
    if (!tableAt(view.state)) return false
    return editTable((t) => {
      const cols = t.aligns.length
      let row = t.row === 1 ? 2 : t.row, col = t.col + dir
      if (col >= cols) { col = 0; row = row === 0 ? 2 : row + 1 }
      if (col < 0) { col = cols - 1; row = row === 2 ? 0 : row - 1 }
      if (row < 0) { row = 0; col = 0 }
      if (row >= t.rows.length) t.rows.push(blankRow(t))
      return { row, col }
    })(view)
  }
}

/* ---------- paste a link over selected text ---------- */

export function pasteLink(view: EditorView, text: string): boolean {
  const ranges = view.state.selection.ranges
  const url = text.trim()
  if (!URL_RE.test(url) || ranges.every((r: SelectionRange) => r.empty)) return false
  const tx = view.state.changeByRange((r) => {
    if (r.empty) return { changes: { from: r.from, insert: url }, range: EditorSelection.cursor(r.from + url.length) }
    const label = view.state.sliceDoc(r.from, r.to)
    if (URL_RE.test(label.trim())) return { changes: { from: r.from, to: r.to, insert: url }, range: EditorSelection.cursor(r.from + url.length) }
    const md = `[${label}](${url})`
    return { changes: { from: r.from, to: r.to, insert: md }, range: EditorSelection.cursor(r.from + md.length) }
  })
  view.dispatch({ ...tx, userEvent: 'input.paste', scrollIntoView: true })
  return true
}
