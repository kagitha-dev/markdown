/*
 * Keyboard shortcuts for the editor, shared by the editor's keymap and the menu labels.
 * Written in CodeMirror's notation: Mod = Ctrl (Cmd on a Mac).
 * Browsers keep some keys for themselves (Ctrl+1–8 switch tabs, Ctrl+N opens a window,
 * Ctrl+Shift+Q quits), so headings use Ctrl+Alt+digit and New uses Ctrl+Alt+N.
 */
export const KEYS: Record<string, string> = {
  // File (handled by the app)
  new: 'Mod-Alt-n',
  open: 'Mod-o',
  openFolder: 'Mod-Shift-o',
  save: 'Mod-s',
  saveAs: 'Mod-Shift-s',
  print: 'Mod-p',
  toggleEdit: 'Mod-Shift-e',
  // Edit
  undo: 'Mod-z',
  redo: 'Mod-Shift-z',
  selectAll: 'Mod-a',
  find: 'Mod-f',
  replace: 'Mod-h',
  gotoLine: 'Mod-Alt-g',
  duplicateLine: 'Shift-Alt-ArrowDown',
  moveLineUp: 'Alt-ArrowUp',
  moveLineDown: 'Alt-ArrowDown',
  deleteLine: 'Mod-Shift-k',
  comment: 'Mod-/',
  // Format
  bold: 'Mod-b',
  italic: 'Mod-i',
  strike: 'Mod-Shift-x',
  code: 'Mod-e',
  link: 'Mod-k',
  // Paragraph
  p: 'Mod-Alt-0',
  h1: 'Mod-Alt-1',
  h2: 'Mod-Alt-2',
  h3: 'Mod-Alt-3',
  h4: 'Mod-Alt-4',
  h5: 'Mod-Alt-5',
  h6: 'Mod-Alt-6',
  headingUp: 'Mod-Alt-=',
  headingDown: 'Mod-Alt--',
  ul: 'Mod-Shift-8',
  ol: 'Mod-Shift-7',
  task: 'Mod-Shift-9',
  taskDone: 'Mod-Alt-x',
  quote: 'Mod-Shift-.',
  indent: 'Mod-]',
  outdent: 'Mod-[',
  // Insert
  codeBlock: 'Mod-Alt-c',
  mathBlock: 'Mod-Alt-m',
  table: 'Mod-Alt-t',
  image: 'Mod-Alt-i',
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** "Mod-Alt-1" → "Ctrl+Alt+1", or "⌘⌥1" on a Mac. */
export function keyLabel(spec: string | undefined): string {
  if (!spec) return ''
  const parts = spec.split(/-(?!$)/)
  const key = parts.pop()!
  const name = (k: string) =>
    ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', '=': '=', '-': '-', '.': '.' } as Record<string, string>)[k] ??
    (k.length === 1 ? k.toUpperCase() : k)
  if (isMac) {
    const sym: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }
    return parts.map((p) => sym[p] ?? p).join('') + name(key)
  }
  const words: Record<string, string> = { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }
  return [...parts.map((p) => words[p] ?? p), name(key)].join('+')
}
