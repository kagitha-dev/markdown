/*
 * The Markdown editor (CodeMirror 6). Loaded only when someone starts editing.
 * Commands are run by id, so the menu bar, the toolbar and the keyboard share one list.
 */
import { useEffect, useRef } from 'react'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import {
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
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--ink)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
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
            paste(e, v) {
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
