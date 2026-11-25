import { useEffect, useMemo, useState } from 'react'
import { Icon } from './icons'

interface Node { name: string; path: string; dirs: Node[]; files: string[] }

function buildTree(paths: string[]): Node {
  const root: Node = { name: '', path: '', dirs: [], files: [] }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join('/') + '/'
      let next = node.dirs.find((d) => d.path === dirPath)
      if (!next) { next = { name: parts[i], path: dirPath, dirs: [], files: [] }; node.dirs.push(next) }
      node = next
    }
    node.files.push(p)
  }
  return root
}

const ancestors = (path: string) => {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/') + '/')
}

export function FileTree({ paths, current, onOpen }: { paths: string[]; current?: string; onOpen: (path: string) => void }) {
  const tree = useMemo(() => buildTree(paths), [paths])
  const [open, setOpen] = useState<Set<string>>(() => new Set(current ? ancestors(current) : []))

  // Reveal the current file when it changes (for example after following a link).
  useEffect(() => {
    if (!current) return
    setOpen((s) => { const n = new Set(s); ancestors(current).forEach((a) => n.add(a)); return n })
    requestAnimationFrame(() => document.querySelector('.tree [aria-current="page"]')?.scrollIntoView({ block: 'nearest' }))
  }, [current])

  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n })

  const render = (node: Node, depth: number): React.ReactNode => (
    <>
      {node.dirs.map((d) => {
        const isOpen = open.has(d.path)
        return (
          <li key={d.path} role="treeitem" aria-expanded={isOpen}>
            <button type="button" className="tree-row tree-dir" style={{ paddingLeft: 6 + depth * 14 }} onClick={() => toggle(d.path)}>
              <span className={'tree-caret' + (isOpen ? ' is-open' : '')}><Icon name="chevron" /></span>
              <span className="tree-label">{d.name}</span>
            </button>
            {isOpen && <ul role="group">{render(d, depth + 1)}</ul>}
          </li>
        )
      })}
      {node.files.map((f) => (
        <li key={f} role="treeitem">
          <button
            type="button" className="tree-row tree-file" style={{ paddingLeft: 26 + depth * 14 }}
            aria-current={f === current ? 'page' : undefined} onClick={() => onOpen(f)} title={f}
          >
            <span className="tree-label">{f.slice(f.lastIndexOf('/') + 1)}</span>
          </button>
        </li>
      ))}
    </>
  )

  return <ul className="tree" role="tree" aria-label="Files">{render(tree, 0)}</ul>
}
