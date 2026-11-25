import { useMemo, type RefObject } from 'react'
import { FileTree } from './file-tree'
import { Icon } from './icons'
import type { RecentEntry } from './recent'
import type { Hit, SearchIndex } from './search'
import type { Workspace } from './workspace'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi')
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>
}

export function FolderPanel(props: {
  ws: Workspace
  current?: string
  query: string
  onQuery: (q: string) => void
  index: SearchIndex | null
  indexing: { done: number; total: number } | null
  onOpen: (path: string, terms?: string[]) => void
  onClose: () => void
  searchRef: RefObject<HTMLInputElement | null>
}) {
  const { ws, current, query, index, indexing } = props
  const hits: Hit[] = useMemo(() => (index && query.trim() ? index.search(query) : []), [index, query])

  return (
    <section className="panel panel--folder" aria-labelledby="folder-h">
      <div className="panel-top">
        <h2 id="folder-h" className="panel-h folder-h" title={ws.name}>
          <Icon name="folder" /><span className="folder-name">{ws.name}</span>
          <span className="panel-count">{ws.docs.length}</span>
        </h2>
        <button type="button" className="link-btn" onClick={props.onClose}>Close</button>
      </div>
      <div className="search">
        <Icon name="search" />
        <input
          ref={props.searchRef} type="search" placeholder="Search files" aria-label={`Search ${ws.name}`}
          value={query} onChange={(e) => props.onQuery(e.target.value)} spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) props.onOpen(hits[0].path, hits[0].terms)
            if (e.key === 'Escape' && query) { e.stopPropagation(); props.onQuery('') }
          }}
        />
      </div>
      {ws.truncated && <p className="panel-note">Only the first {ws.files.size.toLocaleString()} files were read.</p>}
      {query.trim() ? (
        !index ? (
          <p className="panel-empty">Indexing{indexing ? ` ${indexing.done} of ${indexing.total} files` : ''}…</p>
        ) : hits.length ? (
          <ul className="hits" aria-label="Search results">
            {hits.map((h) => (
              <li key={h.path}>
                <button type="button" className="hit" aria-current={h.path === current ? 'page' : undefined} onClick={() => props.onOpen(h.path, h.terms)}>
                  <span className="hit-title"><Highlight text={h.title} terms={h.terms} /></span>
                  <span className="hit-path">{h.path}</span>
                  <span className="hit-snip"><Highlight text={h.snippet} terms={h.terms} /></span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="panel-empty">No files match “{query.trim()}”.</p>
        )
      ) : (
        <div className="tree-wrap"><FileTree paths={ws.docs} current={current} onOpen={(p) => props.onOpen(p)} /></div>
      )}
    </section>
  )
}

function ago(t: number) {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  const d = Math.round(s / 86400)
  return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(t).toLocaleDateString()
}

export function RecentPanel({ items, onOpen, onRemove, onClear }: {
  items: RecentEntry[]
  onOpen: (r: RecentEntry) => void
  onRemove: (r: RecentEntry) => void
  onClear: () => void
}) {
  if (!items.length) return null
  return (
    <section className="panel" aria-labelledby="recent-h">
      <div className="panel-top">
        <h2 id="recent-h" className="panel-h">Recent</h2>
        <button type="button" className="link-btn" onClick={onClear}>Clear</button>
      </div>
      <ul className="recent">
        {items.map((r) => (
          <li key={r.id}>
            <button type="button" className="recent-item" onClick={() => onOpen(r)} title={r.kind === 'folder' && r.path ? `${r.name}/${r.path}` : r.name}>
              <Icon name={r.kind === 'folder' ? 'folder' : 'file'} />
              <span className="recent-text">
                <span className="recent-name">{r.name}</span>
                <span className="recent-meta">{r.kind === 'folder' ? 'Folder · ' : ''}{ago(r.openedAt)}</span>
              </span>
            </button>
            <button type="button" className="recent-x" onClick={() => onRemove(r)} aria-label={`Remove ${r.name} from recent`}><Icon name="close" /></button>
          </li>
        ))}
      </ul>
      <p className="panel-foot">Kept only in this browser.</p>
    </section>
  )
}
