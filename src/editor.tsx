/*
 * The Markdown editor (CodeMirror 6). Loaded only when someone starts editing.
 * Commands are run by id, so the menu bar, the toolbar and the keyboard share one list.
 */
import { useEffect, useRef } from 'react'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import {
  Decoration, MatchDecorator, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate,
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, placeholder,
} from '@codemirror/view'
import {
  defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectAll, indentMore, indentLess,
  copyLineDown, moveLineUp, moveLineDown, deleteLine, toggleComment,
} from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { codeLanguages } from './code-languages'
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel, gotoLine } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'
import * as md from './md-commands'
import { KEYS } from './edit-keys'

export interface EditorApi {
  exec(id: string): boolean
  getText(): string
  /** The line at the top of the editor, with a fraction for how far into it the view is scrolled. */
  topLine(): number
  scrollToLine(line: number): void
  /** Move the cursor to the start of a line and show it. */
  goto(line: number): void
  focus(): void
  /** Re-measure after being hidden. */
  refresh(): void
  /** Insert text at a position (or the selection), on its own if it's a block, plus definitions at the end of the document. */
  insert(text: string, at: number | null, defs?: string[]): void
  /** The document position at a point on screen, if the point is over the text. */
  posAt(x: number, y: number): number | null
}

export interface CursorInfo { line: number; col: number; text: string; selected: number }

interface Props {
  initial: string
  /** Changes reported after this editor's document was replaced are ignored by the app. */
  docKey: number
  wrap: boolean
  lineNumbers: boolean
  onChange: (text: string, docKey: number) => void
  onReady: (api: EditorApi | null) => void
  onScroll: () => void
  onCursor: (c: CursorInfo) => void
  /** Images pasted into the editor. */
  onFiles: (files: File[]) => void
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function titleOf(text: string) {
  const m = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(text)
  return (m?.[1] ?? 'Untitled').replace(/"/g, "'")
}

/** Every command the menus, toolbar and keys can run. Ids with a colon take an argument (table:3x3, alert:note). */
function command(id: string): md.Cmd | null {
  const [name, arg] = id.split(':')
  switch (name) {
    case 'undo': return undo
    case 'redo': return redo
    case 'selectAll': return selectAll
    case 'find': return openSearchPanel
    case 'replace': return (v) => {
      openSearchPanel(v)
      requestAnimationFrame(() => v.dom.querySelector<HTMLInputElement>('.cm-search input[name=replace]')?.focus())
      return true
    }
    case 'gotoLine': return gotoLine
    case 'duplicateLine': return copyLineDown
    case 'moveLineUp': return moveLineUp
    case 'moveLineDown': return moveLineDown
    case 'deleteLine': return deleteLine
    case 'comment': return toggleComment
    case 'bold': return md.toggleWrap('**', '**', 'bold text')
    case 'italic': return md.toggleWrap('*', '*', 'italic text')
    case 'strike': return md.toggleWrap('~~', '~~', 'struck text')
    case 'code': return md.toggleWrap('`', '`', 'code')
    case 'inlineMath': return md.inlineMath
    case 'link': return md.link
    case 'image': return md.image
    case 'clear': return md.clearFormatting
    case 'p': return md.setHeading(0)
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return md.setHeading(+name[1])
    case 'headingUp': return md.shiftHeading(1)
    case 'headingDown': return md.shiftHeading(-1)
    case 'ul': return md.toggleList('ul')
    case 'ol': return md.toggleList('ol')
    case 'task': return md.toggleList('task')
    case 'taskDone': return md.toggleTaskDone
    case 'quote': return md.toggleQuote
    case 'indent': return indentMore
    case 'outdent': return indentLess
    case 'paragraphBefore': return md.paragraphBefore
    case 'paragraphAfter': return md.paragraphAfter
    case 'codeBlock': return md.codeBlock
    case 'mathBlock': return md.mathBlock
    case 'mermaid': return md.mermaid
    case 'details': return md.details
    case 'hr': return md.hr
    case 'footnote': return md.footnote
    case 'linkRef': return md.linkReference
    case 'toc': return md.tableOfContents
    case 'date': return md.date
    case 'alert': return md.alert(arg || 'note')
    case 'frontMatter': return (v) => md.frontMatter(`title: "${titleOf(v.state.doc.toString())}"\ndate: ${today()}\ntags: []`)(v)
    case 'okfFrontMatter': return (v) => md.frontMatter(
      `type: concept\ntitle: "${titleOf(v.state.doc.toString())}"\ndescription: \nstatus: draft\ntags: []\ngenerated:\n  by: human:you\n  at: ${today()}`,
    )(v)
    case 'table': {
      const [c, r] = (arg || '3x3').split('x').map(Number)
      return md.insertTable(c || 3, r || 3)
    }
    case 'rowAbove': return md.tableRowAbove
    case 'rowBelow': return md.tableRowBelow
    case 'colLeft': return md.tableColumnLeft
    case 'colRight': return md.tableColumnRight
    case 'delRow': return md.tableDeleteRow
    case 'delCol': return md.tableDeleteColumn
    case 'alignLeft': return md.tableAlign('left')
    case 'alignCenter': return md.tableAlign('center')
    case 'alignRight': return md.tableAlign('right')
    case 'formatTable': return md.tableFormat
  }
  return null
}

/** Ids that have their own key in KEYS and are handled inside the editor. */
const EDITOR_KEYS = [
  'bold', 'italic', 'strike', 'code', 'link', 'image', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'headingUp', 'headingDown',
  'ul', 'ol', 'task', 'taskDone', 'quote', 'codeBlock', 'mathBlock', 'table', 'replace',
]

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.32em', color: 'var(--ink)' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.18em', color: 'var(--ink)' },
  { tag: t.heading3, fontWeight: '650', fontSize: '1.07em', color: 'var(--ink)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '650', color: 'var(--ink)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--ed-url)' },
  { tag: t.monospace, color: 'var(--ed-code)' },
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName], color: 'var(--ed-mark)' },
  { tag: t.quote, color: 'var(--ink-2)', fontStyle: 'italic' },
  { tag: [t.meta, t.comment, t.documentMeta], color: 'var(--muted)' },
  { tag: [t.keyword, t.tagName, t.operatorKeyword, t.modifier], color: 'var(--ed-kw)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--ed-str)' },
  { tag: [t.number, t.bool, t.atom, t.null], color: 'var(--ed-num)' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], color: 'var(--ed-prop)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--ed-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--ed-fn)' },
  { tag: t.invalid, color: 'var(--danger)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--ink)', fontSize: '14.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontVariantLigatures: 'none', lineHeight: '1.75', overscrollBehavior: 'contain' },
  '.cm-content': { padding: '22px 0 45vh', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 clamp(14px, 3vw, 30px)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'color-mix(in srgb, var(--muted) 75%, transparent)', border: 'none', fontSize: '12.5px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 14px', minWidth: '44px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--accent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, #ffd23f 45%, transparent)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, #ff8c1a 60%, transparent)' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)', outline: 'none' },
  '.cm-placeholder': { color: 'var(--muted)', fontStyle: 'normal' },
  '.cm-data-chip': { display: 'inline-block', padding: '0 7px', borderRadius: '5px', background: 'var(--accent-soft)', color: 'var(--accent)', fontFamily: 'var(--sans)', fontSize: '12px', lineHeight: '1.6', verticalAlign: 'baseline' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--ink)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
})

/* Images embedded in the file (data: URLs) are long runs of characters; show them as a small label instead. */
class DataChip extends WidgetType {
  constructor(readonly kind: string, readonly size: number) { super() }
  eq(o: DataChip) { return o.kind === this.kind && o.size === this.size }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-data-chip'
    const kb = this.size * 0.75 / 1024
    el.textContent = `${this.kind.toUpperCase()} image data · ${kb < 1024 ? Math.max(1, Math.round(kb)) + ' KB' : (kb / 1024).toFixed(1) + ' MB'}`
    el.title = 'An image stored inside this file. Delete the whole line to remove it.'
    return el
  }
  ignoreEvent() { return false }
}
const dataMatcher = new MatchDecorator({
  regexp: /data:image\/([a-z0-9.+-]+);base64,[A-Za-z0-9+/=]{40,}/gi,
  decoration: (m) => Decoration.replace({ widget: new DataChip(m[1].replace('svg+xml', 'svg').replace('jpeg', 'jpg'), m[0].length) }),
})
const dataChips = ViewPlugin.fromClass(class {
  chips: DecorationSet
  constructor(view: EditorView) { this.chips = dataMatcher.createDeco(view) }
  update(u: ViewUpdate) { this.chips = dataMatcher.updateDeco(u, this.chips) }
}, {
  decorations: (v) => v.chips,
  // The cursor steps over the whole thing, and deleting removes it in one go.
  provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.chips ?? Decoration.none),
})

export default function Editor(p: Props) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const wrapC = useRef(new Compartment())
  const numC = useRef(new Compartment())
  const props = useRef(p)
  props.current = p

  useEffect(() => {
    let timer = 0
    let cursorFrame = 0
    const myKey = p.docKey
    const flush = (v: EditorView) => { timer = 0; props.current.onChange(v.state.doc.toString(), myKey) }
    const reportCursor = (v: EditorView) => {
      cursorFrame = 0
      const r = v.state.selection.main
      const line = v.state.doc.lineAt(r.head)
      props.current.onCursor({ line: line.number, col: r.head - line.from + 1, text: line.text, selected: Math.abs(r.to - r.from) })
    }
    const exec = (id: string) => {
      const v = viewRef.current
      const cmd = command(id)
      if (!v || !cmd) return false
      return cmd(v)
    }
    const keys = EDITOR_KEYS.filter((id) => KEYS[id]).map((id) => ({ key: KEYS[id], run: () => exec(id), preventDefault: true }))

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: p.initial,
        extensions: [
          numC.current.of(p.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
          wrapC.current.of(p.wrap ? EditorView.lineWrapping : []),
          history(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          indentOnInput(),
          bracketMatching(),
          EditorState.allowMultipleSelections.of(true),
          search({ top: true }),
          yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages }) }),
          syntaxHighlighting(highlight),
          dataChips,
          theme,
          placeholder('Start writing Markdown…  # for a heading, - for a list, or use the menus above.'),
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown editor', spellcheck: 'true', autocorrect: 'off', autocapitalize: 'sentences' }),
          Prec.high(keymap.of([
            ...keys,
            { key: 'Tab', run: md.tableTab(1) },
            { key: 'Shift-Tab', run: md.tableTab(-1) },
          ])),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.domEventHandlers({
            // Dropped files are handled by the app (images are saved or embedded); never inserted as text here.
            drop(e) { return !!e.dataTransfer?.files.length },
            paste(e, v) {
              // A copied image (screenshot, image from a web page) with no text alongside it.
              const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
              if (files.length && !e.clipboardData?.getData('text/plain').trim()) {
                e.preventDefault()
                props.current.onFiles(files)
                return true
              }
              const text = e.clipboardData?.getData('text/plain')
              if (text && md.pasteLink(v, text)) { e.preventDefault(); return true }
              return false
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              // Large files: wait for a pause in typing before the preview and word count update.
              if (timer) clearTimeout(timer)
              if (u.state.doc.length > 200_000) timer = window.setTimeout(() => flush(u.view), 250)
              else flush(u.view)
            }
            if ((u.selectionSet || u.docChanged) && !cursorFrame) cursorFrame = requestAnimationFrame(() => reportCursor(u.view))
          }),
        ],
      }),
    })
    viewRef.current = view
    if (import.meta.env.DEV) (window as any).__kmvView = view // for tests on the dev server
    const onScroll = () => props.current.onScroll()
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })

    const padding = () => view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop
    const api: EditorApi = {
      exec,
      getText: () => view.state.doc.toString(),
      topLine() {
        const h = view.scrollDOM.scrollTop - padding()
        const block = view.lineBlockAtHeight(Math.max(0, h))
        const line = view.state.doc.lineAt(block.from).number
        return line + Math.min(1, Math.max(0, (h - block.top) / Math.max(1, block.height)))
      },
      scrollToLine(x) {
        const n = Math.max(1, Math.min(view.state.doc.lines, Math.floor(x)))
        const block = view.lineBlockAt(view.state.doc.line(n).from)
        view.scrollDOM.scrollTop = block.top + (x - Math.floor(x)) * block.height + padding()
      },
      goto(n) {
        const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, n)))
        view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 40 }) })
        view.focus()
      },
      focus: () => view.focus(),
      refresh: () => view.requestMeasure(),
      insert(text, at, defs = []) {
        const { state } = view
        const sel = state.selection.main
        const from = at ?? sel.from
        const to = at ?? sel.to
        const line = state.doc.lineAt(from)
        // Images go on their own line(s) unless they're dropped into the middle of text.
        const prevLine = line.number > 1 ? state.doc.line(line.number - 1).text : ''
        const before = from > line.from && state.sliceDoc(from - 1, from).trim() ? '\n\n'
          : from === line.from && !line.text.trim() && prevLine.trim() ? '\n' : ''
        // Text after the drop point moves below; at the end of a line the cursor goes to a fresh paragraph.
        const atEnd = !state.sliceDoc(to, state.doc.lineAt(to).to).trim()
        const after = '\n\n'
        const insert = before + text + after
        let changes = state.changes({ from, to, insert })
        let anchor = from + before.length + text.length + (atEnd ? after.length : 0)
        if (defs.length) {
          // Definitions go after everything, including what was just inserted (at the end of an empty document they'd join its line).
          const next = state.update({ changes }).state
          const d = md.appendDefinition(next, defs.join('\n'))
          // Keep an empty paragraph for the cursor between the image and the definitions.
          const more = next.changes({ from: d.from, insert: (d.from === anchor ? '\n\n' : '') + d.insert })
          changes = changes.compose(more)
          anchor = more.mapPos(anchor, -1)
        }
        view.dispatch({ changes, selection: { anchor }, scrollIntoView: true, userEvent: 'input.paste' })
        view.focus()
      },
      posAt: (x, y) => {
        const r = view.scrollDOM.getBoundingClientRect()
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null
        return view.posAtCoords({ x, y })
      },
    }
    props.current.onReady(api)
    reportCursor(view)
    view.focus()
    return () => {
      if (timer) { clearTimeout(timer); flush(view) }
      cancelAnimationFrame(cursorFrame)
      view.scrollDOM.removeEventListener('scroll', onScroll)
      props.current.onReady(null)
      view.destroy()
      viewRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapC.current.reconfigure(p.wrap ? EditorView.lineWrapping : []) })
  }, [p.wrap])
  useEffect(() => {
    viewRef.current?.dispatch({ effects: numC.current.reconfigure(p.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []) })
  }, [p.lineNumbers])

  return <div className="editor-host" ref={host} />
}
