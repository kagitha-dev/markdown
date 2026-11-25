/*
 * The editor's menu bar (File, Edit, Format, Paragraph, Insert, Table, View, Help) and its toolbar.
 * Menus are plain data, so the keyboard-shortcuts dialog is built from the same list.
 * Keyboard: arrows move between menus and items, Right opens a submenu, Esc closes.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './icons'
import { keyLabel } from './edit-keys'

export type MenuItem =
  | '-'
  | { label: string; run?: () => void; keys?: string; icon?: string; disabled?: boolean; checked?: boolean; radio?: boolean; sub?: MenuItem[]; hint?: string }
export interface MenuDef { label: string; items: MenuItem[] }

type Entry = Exclude<MenuItem, '-'>

export function MenuBar({ menus, children }: { menus: MenuDef[]; children?: ReactNode }) {
  const [open, setOpen] = useState<number | null>(null)
  const [sub, setSub] = useState<number | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const tops = useRef<(HTMLButtonElement | null)[]>([])
  /** Whether the open menu came from the keyboard, so its first item gets focus. */
  const viaKey = useRef(false)

  const close = (refocus = false) => {
    const i = open
    setOpen(null); setSub(null)
    if (refocus && i !== null) tops.current[i]?.focus()
  }

  useEffect(() => {
    if (open === null) return
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) { setOpen(null); setSub(null) } }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  useEffect(() => {
    if (open === null) return
    const list = root.current?.querySelector<HTMLElement>(`[data-menu="${open}"]`)
    // From the keyboard the first item gets focus; from a click the list does, so arrow keys work.
    if (viaKey.current) list?.querySelector<HTMLElement>('[role^=menuitem]:not([aria-disabled=true])')?.focus()
    else list?.focus({ preventScroll: true })
  }, [open])
  useEffect(() => {
    if (sub === null || open === null) return
    const list = root.current?.querySelector<HTMLElement>(`[data-sub="${open}-${sub}"]`)
    if (viaKey.current) list?.querySelector<HTMLElement>('[role^=menuitem]:not([aria-disabled=true])')?.focus()
  }, [sub, open])

  const items = (el: HTMLElement | null) =>
    Array.from(el?.querySelectorAll<HTMLElement>(':scope > [role^=menuitem]:not([aria-disabled=true]), :scope > .mb-subwrap > [role^=menuitem]:not([aria-disabled=true])') ?? [])

  const step = (dir: 1 | -1) => {
    const n = menus.length
    const next = open === null ? 0 : (open + dir + n) % n
    viaKey.current = true
    setSub(null); setOpen(next)
    tops.current[next]?.focus()
  }

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>, isSub: boolean) => {
    const list = e.currentTarget
    const all = items(list)
    const i = all.indexOf(document.activeElement as HTMLElement)
    const move = (j: number) => { e.preventDefault(); all[(j + all.length) % all.length]?.focus() }
    switch (e.key) {
      case 'ArrowDown': move(i + 1); break
      case 'ArrowUp': move(i - 1); break
      case 'Home': move(0); break
      case 'End': move(all.length - 1); break
      case 'ArrowRight': {
        e.preventDefault()
        const el = document.activeElement as HTMLElement | null
        if (el?.dataset.subIndex) { viaKey.current = true; setSub(+el.dataset.subIndex) }
        else step(1)
        break
      }
      case 'ArrowLeft':
        e.preventDefault()
        if (isSub) { const s = sub; setSub(null); root.current?.querySelector<HTMLElement>(`[data-menu="${open}"] [data-sub-index="${s}"]`)?.focus() }
        else step(-1)
        break
      case 'Escape':
        e.preventDefault(); e.stopPropagation()
        if (isSub) { const s = sub; setSub(null); root.current?.querySelector<HTMLElement>(`[data-menu="${open}"] [data-sub-index="${s}"]`)?.focus() }
        else close(true)
        break
      case 'Tab': close(); break
    }
  }

  const activate = (it: Entry) => {
    if (it.disabled || !it.run) return
    setOpen(null); setSub(null)
    // Let the menu close (and the editor take focus back) before running.
    requestAnimationFrame(() => it.run!())
  }

  const renderItems = (list: MenuItem[], menuIndex: number, isSub: boolean) =>
    list.map((it, j) => {
      if (it === '-') return <div key={'s' + j} className="mb-sep" role="separator" />
      const role = it.radio ? 'menuitemradio' : it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'
      const body = (
        <>
          <span className="mb-check" aria-hidden="true">{it.checked ? <Icon name={it.radio ? 'dot' : 'check'} /> : it.icon ? <Icon name={it.icon} /> : null}</span>
          <span className="mb-label">{it.label}{it.hint && <span className="mb-hint">{it.hint}</span>}</span>
          {it.sub ? <span className="mb-arrow" aria-hidden="true"><Icon name="chevron" /></span> : <span className="mb-key">{keyLabel(it.keys)}</span>}
        </>
      )
      if (it.sub) {
        const openSub = !isSub && sub === j
        return (
          <div key={j} className="mb-subwrap" onPointerEnter={(e) => { if (e.pointerType === 'mouse') { viaKey.current = false; setSub(j) } }}>
            <button
              type="button" role="menuitem" className="mb-item" aria-haspopup="menu" aria-expanded={openSub}
              aria-disabled={it.disabled || undefined} data-sub-index={j} tabIndex={-1}
              onClick={() => { viaKey.current = false; setSub(openSub ? null : j) }}
            >{body}</button>
            {openSub && (
              <div className="mb-menu mb-menu--sub" role="menu" aria-label={it.label} data-sub={`${menuIndex}-${j}`} tabIndex={-1} onKeyDown={(e) => { e.stopPropagation(); onMenuKey(e, true) }}>
                {renderItems(it.sub, menuIndex, true)}
              </div>
            )}
          </div>
        )
      }
      return (
        <button
          key={j} type="button" role={role} className="mb-item" tabIndex={-1}
          aria-checked={it.checked !== undefined ? it.checked : undefined}
          aria-disabled={it.disabled || undefined}
          onPointerEnter={(e) => { if (!isSub && e.pointerType === 'mouse') setSub(null) }}
          onClick={() => activate(it)}
        >{body}</button>
      )
    })

  return (
    <div className="mb" ref={root}>
      <div className="mb-menus" role="menubar" aria-label="Editor menu">
        {menus.map((m, i) => (
          <div key={m.label} className="mb-top">
            <button
              ref={(el) => { tops.current[i] = el }}
              type="button" role="menuitem" className="mb-topbtn" aria-haspopup="menu" aria-expanded={open === i}
              tabIndex={i === 0 ? 0 : -1}
              onClick={() => { viaKey.current = false; setSub(null); setOpen(open === i ? null : i) }}
              onPointerEnter={(e) => { if (open !== null && open !== i && e.pointerType === 'mouse') { viaKey.current = false; setSub(null); setOpen(i) } }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); viaKey.current = true; setSub(null); setOpen(i) }
                else if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
                else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
                else if (e.key === 'Escape' && open !== null) { e.preventDefault(); e.stopPropagation(); close(true) }
              }}
            >{m.label}</button>
            {open === i && (
              <div className="mb-menu" role="menu" aria-label={m.label} data-menu={i} tabIndex={-1} onKeyDown={(e) => onMenuKey(e, false)}>
                {renderItems(m.items, i, false)}
              </div>
            )}
          </div>
        ))}
      </div>
      {children}
    </div>
  )
}

/* ---------- toolbar ---------- */

export interface ToolDef { id: string; icon: string; label: string; keys?: string }

export function Toolbar({ groups, onRun, block, onBlock }: {
  groups: ToolDef[][]
  onRun: (id: string) => void
  /** Current block type for the style picker: 0 = paragraph, 1–6 = heading level. */
  block: number
  onBlock: (level: number) => void
}) {
  return (
    <div className="tb" role="toolbar" aria-label="Formatting">
      <select
        className="tb-select" value={block} aria-label="Text style" title="Text style"
        onChange={(e) => onBlock(+e.target.value)}
      >
        <option value={0}>Paragraph</option>
        {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>Heading {n}</option>)}
      </select>
      {groups.map((g, i) => (
        <Fragment key={i}>
          <span className="tb-sep" aria-hidden="true" />
          {g.map((t) => (
            <button
              key={t.id} type="button" className="tb-btn"
              title={t.label + (t.keys ? ` (${keyLabel(t.keys)})` : '')} aria-label={t.label}
              // Keep the editor's focus and selection.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onRun(t.id)}
            ><Icon name={t.icon} /></button>
          ))}
        </Fragment>
      ))}
    </div>
  )
}

/* ---------- keyboard shortcuts dialog ---------- */

export function ShortcutsDialog({ menus, onClose }: { menus: MenuDef[]; onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const collect = (list: MenuItem[], out: Entry[] = []) => {
    for (const it of list) { if (it === '-') continue; if (it.sub) collect(it.sub, out); else if (it.keys) out.push(it) }
    return out
  }
  return (
    <div className="drawer-scrim center" onClick={onClose}>
      <div className="dialog dialog--keys" role="dialog" aria-modal="true" aria-labelledby="keys-h" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
        <div className="keys-top">
          <h2 id="keys-h">Keyboard shortcuts</h2>
          <button ref={ref} type="button" className="btn btn--icon" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="keys-grid">
          {menus.map((m) => {
            const list = collect(m.items)
            if (!list.length) return null
            return (
              <section key={m.label}>
                <h3>{m.label}</h3>
                <dl>
                  {list.map((it) => <div key={it.label}><dt>{it.label}</dt><dd><kbd>{keyLabel(it.keys)}</kbd></dd></div>)}
                </dl>
              </section>
            )
          })}
          <section>
            <h3>While typing</h3>
            <dl>
              <div><dt>Continue a list or quote</dt><dd><kbd>Enter</kbd></dd></div>
              <div><dt>Next table cell</dt><dd><kbd>Tab</kbd></dd></div>
              <div><dt>Indent a list item</dt><dd><kbd>Tab</kbd></dd></div>
              <div><dt>Paste a link over selected text</dt><dd><kbd>{keyLabel('Mod-v')}</kbd></dd></div>
            </dl>
          </section>
        </div>
      </div>
    </div>
  )
}

/** Input dialog for a file name. */
export function NameDialog({ title, note, initial, action, onClose, onSubmit }: {
  title: string; note: string; initial: string; action: string; onClose: () => void; onSubmit: (v: string) => void
}) {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = initial.lastIndexOf('.')
    el.setSelectionRange(initial.lastIndexOf('/') + 1, dot > 0 ? dot : initial.length)
  }, [initial])
  return (
    <div className="drawer-scrim center" onClick={onClose}>
      <form className="dialog dialog--name" role="dialog" aria-modal="true" aria-labelledby="name-h"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSubmit(v.trim()) }}>
        <h2 id="name-h">{title}</h2>
        <p>{note}</p>
        <input ref={ref} className="name-input" value={v} onChange={(e) => setV(e.target.value)} spellCheck={false} aria-label="File name" />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!v.trim()}>{action}</button>
        </div>
      </form>
    </div>
  )
}

/** Choose a folder to move a file or folder into. */
export function MoveDialog({ path, root, dirs, onClose, onSubmit }: {
  path: string; root: string; dirs: string[]; onClose: () => void; onSubmit: (dir: string) => void
}) {
  const isDir = path.endsWith('/')
  const parent = path.replace(/[^/]+\/?$/, '')
  // Not into itself, nor where it already is.
  const options = ['', ...dirs].filter((d) => d !== parent && !(isDir && d.startsWith(path)))
  const [v, setV] = useState(options[0] ?? '')
  const ref = useRef<HTMLSelectElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const name = path.replace(/\/$/, '').split('/').pop()
  return (
    <div className="drawer-scrim center" onClick={onClose}>
      <form className="dialog dialog--name" role="dialog" aria-modal="true" aria-labelledby="move-h"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
        onSubmit={(e) => { e.preventDefault(); if (options.length) onSubmit(v) }}>
        <h2 id="move-h">Move {name}</h2>
        <p>Links to it in other files are updated.</p>
        {options.length ? (
          <select ref={ref} className="name-input" value={v} onChange={(e) => setV(e.target.value)} aria-label="Move to folder" size={Math.min(10, Math.max(4, options.length))}>
            {options.map((d) => <option key={d} value={d}>{d ? `${root}/${d}` : `${root} (top level)`}</option>)}
          </select>
        ) : <p>There's no other folder to move it to. Make one with New folder first.</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!options.length}>Move</button>
        </div>
      </form>
    </div>
  )
}
