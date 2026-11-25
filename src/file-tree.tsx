import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './icons'

interface Node { name: string; path: string; dirs: Node[]; files: string[] }

function buildTree(paths: string[], emptyDirs: string[] = []): Node {
  const root: Node = { name: '', path: '', dirs: [], files: [] }
  const dirNode = (parts: string[]) => {
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const dirPath = parts.slice(0, i + 1).join('/') + '/'
      let next = node.dirs.find((d) => d.path === dirPath)
      if (!next) { next = { name: parts[i], path: dirPath, dirs: [], files: [] }; node.dirs.push(next) }
      node = next
    }
    return node
  }
  for (const p of paths) {
    const parts = p.split('/')
    dirNode(parts.slice(0, -1)).files.push(p)
  }
  for (const d of emptyDirs) dirNode(d.split('/').filter(Boolean))
  const sort = (n: Node) => { n.dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })); n.dirs.forEach(sort) }
  sort(root)
  return root
}

const ancestors = (path: string) => {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/') + '/')
}

/** Changing files in the folder (Chrome and Edge). Folder paths end with "/". */
export interface TreeActions {
  newFile: (dir: string) => void
  newFolder: (dir: string) => void
  rename: (path: string) => void
  move: (path: string) => void
  moveTo: (path: string, dir: string) => void
  duplicate: (path: string) => void
  remove: (path: string) => void
}

const DRAG = 'application/x-kmv-path'

export function FileTree({ paths, current, onOpen, actions, emptyDirs }: {
  paths: string[]; current?: string; onOpen: (path: string) => void; actions?: TreeActions; emptyDirs?: string[]
}) {
  const tree = useMemo(() => buildTree(paths, emptyDirs), [paths, emptyDirs])
  const [open, setOpen] = useState<Set<string>>(() => new Set(current ? ancestors(current) : []))
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; right: boolean } | null>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)
  const dragging = useRef<string | null>(null)

  // Reveal the current file when it changes (for example after following a link).
  useEffect(() => {
    if (!current) return
    setOpen((s) => { const n = new Set(s); ancestors(current).forEach((a) => n.add(a)); return n })
    requestAnimationFrame(() => document.querySelector('.tree [aria-current="page"]')?.scrollIntoView({ block: 'nearest' }))
  }, [current])

  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n })

  const openMenu = (e: React.MouseEvent, path: string, fromButton: boolean) => {
    if (!actions) return
    e.preventDefault()
    if (fromButton) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setMenu({ x: r.right, y: r.bottom + 4, path, right: true })
    } else setMenu({ x: e.clientX, y: e.clientY, path, right: false })
  }

  /* Drag a file or folder onto a folder (or the empty space below the tree for the top level) to move it. */
  const canDrop = (dir: string) => {
    const from = dragging.current
    if (!from) return false
    const parent = from.replace(/[^/]+\/?$/, '')
    return parent !== dir && !(from.endsWith('/') && dir.startsWith(from))
  }
  const dropProps = (dir: string) => actions ? {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG) || !canDrop(dir)) return
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDropAt(dir)
    },
    onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as HTMLElement | null)) setDropAt((d) => (d === dir ? null : d)) },
    onDrop: (e: React.DragEvent) => {
      const from = e.dataTransfer.getData(DRAG)
      if (!from || !canDrop(dir)) return
      e.preventDefault(); e.stopPropagation(); setDropAt(null); dragging.current = null
      actions.moveTo(from, dir)
    },
  } : {}
  const dragProps = (path: string) => actions ? {
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData(DRAG, path); e.dataTransfer.effectAllowed = 'move'; dragging.current = path },
    onDragEnd: () => { dragging.current = null; setDropAt(null) },
  } : {}

  const more = (path: string, label: string) => actions && (
    <button type="button" className="tree-more" aria-label={`More actions for ${label}`} title="More actions" onClick={(e) => openMenu(e, path, true)}>
      <Icon name="more" />
    </button>
  )

  const render = (node: Node, depth: number): React.ReactNode => (
    <>
      {node.dirs.map((d) => {
        const isOpen = open.has(d.path)
        return (
          <li key={d.path} role="treeitem" aria-expanded={isOpen} {...dropProps(d.path)} className={dropAt === d.path ? 'is-drop' : undefined}>
            <div className="tree-item" onContextMenu={(e) => openMenu(e, d.path, false)}>
              <button type="button" className="tree-row tree-dir" style={{ paddingLeft: 6 + depth * 14 }} onClick={() => toggle(d.path)} {...dragProps(d.path)}>
                <span className={'tree-caret' + (isOpen ? ' is-open' : '')}><Icon name="chevron" /></span>
                <span className="tree-label">{d.name}</span>
              </button>
              {more(d.path, d.name)}
            </div>
            {isOpen && (
              <ul role="group">
                {render(d, depth + 1)}
                {!d.dirs.length && !d.files.length && <li className="tree-empty" style={{ paddingLeft: 26 + (depth + 1) * 14 }}>Empty folder</li>}
              </ul>
            )}
          </li>
        )
      })}
      {node.files.map((f) => {
        const name = f.slice(f.lastIndexOf('/') + 1)
        return (
          <li key={f} role="treeitem">
            <div className="tree-item" onContextMenu={(e) => openMenu(e, f, false)}>
              <button
                type="button" className="tree-row tree-file" style={{ paddingLeft: 26 + depth * 14 }}
                aria-current={f === current ? 'page' : undefined} onClick={() => onOpen(f)} title={f} {...dragProps(f)}
              >
                <span className="tree-label">{name}</span>
              </button>
              {more(f, name)}
            </div>
          </li>
        )
      })}
    </>
  )

  return (
    <>
      <ul className={'tree' + (actions ? ' tree--edit' : '') + (dropAt === '' ? ' is-drop-root' : '')} role="tree" aria-label="Files" {...dropProps('')}>
        {render(tree, 0)}
      </ul>
      {menu && actions && <TreeMenu {...menu} actions={actions} onClose={() => setMenu(null)} />}
    </>
  )
}

function TreeMenu({ x, y, right, path, actions, onClose }: { x: number; y: number; right: boolean; path: string; actions: TreeActions; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const isDir = path.endsWith('/')
  const dir = isDir ? path : path.replace(/[^/]+$/, '')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Keep the menu on screen.
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(right ? x - r.width : x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
    el.querySelector<HTMLElement>('button')?.focus()
    const away = (e: PointerEvent) => { if (!el.contains(e.target as HTMLElement)) onClose() }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = Array.from(el.querySelectorAll<HTMLElement>('button'))
        const i = items.indexOf(document.activeElement as HTMLElement)
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('resize', onClose)
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', onClose) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const item = (icon: string, label: string, fn: () => void, danger = false) => (
    <button type="button" role="menuitem" className={'mb-item' + (danger ? ' is-danger' : '')} onClick={() => { onClose(); fn() }}>
      <span className="mb-check"><Icon name={icon} /></span><span className="mb-label">{label}</span><span />
    </button>
  )
  return (
    <div ref={ref} className="mb-menu tree-menu" role="menu" aria-label={`Actions for ${path}`} style={{ position: 'fixed', left: pos.left, top: pos.top }}>
      {item('newfile', isDir ? 'New file here…' : 'New file next to it…', () => actions.newFile(dir))}
      {item('folderplus', isDir ? 'New folder here…' : 'New folder next to it…', () => actions.newFolder(dir))}
      <div className="mb-sep" role="separator" />
      {item('edit', 'Rename…', () => actions.rename(path))}
      {item('move', 'Move to…', () => actions.move(path))}
      {!isDir && item('copy', 'Duplicate', () => actions.duplicate(path))}
      <div className="mb-sep" role="separator" />
      {item('trash', isDir ? 'Delete folder…' : 'Delete…', () => actions.remove(path), true)}
    </div>
  )
}
