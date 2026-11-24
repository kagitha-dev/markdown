import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'

interface Props {
  canDownload: boolean
  busy: boolean
  hasFm: boolean
  includeFm: boolean
  onIncludeFm: (v: boolean) => void
  onPdf: () => void
  onHtml: () => void
  onMd: () => void
  onCopyRich: () => void
  onCopyMd: () => void
}

export function ExportMenu(p: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus() }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])') ?? [])
        const i = items.indexOf(document.activeElement as HTMLElement)
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
        items[next]?.focus()
      }
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key, true)
    root.current?.querySelector<HTMLElement>('[role=menuitem]:not([disabled])')?.focus()
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key, true) }
  }, [open])

  const run = (fn: () => void) => () => { setOpen(false); fn() }

  const item = (icon: string, label: string, hint: string, fn: () => void, disabled = false) => (
    <button type="button" role="menuitem" className="menu-item" onClick={run(fn)} disabled={disabled}>
      <Icon name={icon} />
      <span className="menu-text">
        <span className="menu-label">{label}</span>
        <span className="menu-hint">{hint}</span>
      </span>
    </button>
  )

  return (
    <div className="menu-root" ref={root}>
      <button
        ref={btn} type="button" className="btn" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)} disabled={p.busy} title="Export"
      >
        <Icon name="download" /><span className="btn-text">{p.busy ? 'Exporting…' : 'Export'}</span>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Export">
          {p.canDownload ? (
            <>
              <div className="menu-group">Save as</div>
              {item('pdf', 'PDF', 'Print dialog → Save as PDF · Ctrl+P', p.onPdf)}
              {item('code', 'HTML', 'One file, works offline', p.onHtml)}
              {item('md', 'Markdown', 'The original .md file', p.onMd)}
            </>
          ) : (
            <p className="menu-note">Saving files works on markdown.kagitha.com. Copying works here.</p>
          )}
          <div className="menu-group">Copy</div>
          {item('rich', 'Formatted text', 'For Google Docs, Word or email', p.onCopyRich)}
          {item('copy', 'Markdown', 'The raw source', p.onCopyMd)}
          <label className={'menu-check' + (p.hasFm ? '' : ' is-off')}>
            <input
              type="checkbox" checked={p.includeFm && p.hasFm} disabled={!p.hasFm}
              onChange={(e) => p.onIncludeFm(e.target.checked)}
            />
            <span>Include frontmatter<span className="menu-hint">{p.hasFm ? 'In PDF, HTML and formatted text' : 'This file has none'}</span></span>
          </label>
        </div>
      )}
    </div>
  )
}
