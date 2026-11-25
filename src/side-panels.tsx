import { useMemo, useState, type RefObject } from 'react'
import { FileTree } from './file-tree'
import { Icon } from './icons'
import { activeCount, facetValues, matches, NO_TYPE, type Filters } from './filters'
import { TIER_LABEL, type TrustTier } from './okf-core'
import type { RecentEntry } from './recent'
import type { Hit } from './search'
import type { Scan } from './scan'
import type { Analysis, DocInfo, Issue, Level, NavSection } from './okf'
import type { Workspace } from './workspace'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi')
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>
}

const LEVEL_LABEL: Record<Level, [string, string]> = { error: ['error', 'errors'], warning: ['warning', 'warnings'], info: ['note', 'notes'] }
const plural = (n: number, l: Level) => `${n.toLocaleString()} ${LEVEL_LABEL[l][n === 1 ? 0 : 1]}`

type Tab = 'contents' | 'files' | 'checks'
export interface OpenOpts { terms?: string[]; href?: string }

export function FolderPanel(props: {
  ws: Workspace
  current?: string
  query: string
  onQuery: (q: string) => void
  scan: Scan | null
  indexing: { done: number; total: number } | null
  filters: Filters
  onFilters: (f: Filters) => void
  onOpen: (path: string, opts?: OpenOpts) => void
  onClose: () => void
  searchRef: RefObject<HTMLInputElement | null>
}) {
  const { ws, current, query, scan, indexing, filters } = props
  const a = scan?.analysis ?? null
  const [tab, setTab] = useState<Tab | null>(null)
  const [showFilters, setShowFilters] = useState(false)
  const nFilters = activeCount(filters)
  const shownTab: Tab = tab ?? (a?.nav ? 'contents' : 'files')

  const hits: Hit[] = useMemo(() => {
    if (!scan || !query.trim()) return []
    const all = scan.index.search(query)
    return nFilters ? all.filter((h) => { const d = a?.docs.get(h.path); return !d || matches(d, filters) }) : all
  }, [scan, query, filters, nFilters, a])

  const filtered: DocInfo[] = useMemo(
    () => (a && nFilters ? ws.docs.map((p) => a.docs.get(p)).filter((d): d is DocInfo => !!d && matches(d, filters)) : []),
    [a, ws.docs, filters, nFilters],
  )

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0 }
    a?.issues.forEach((i) => c[i.level]++)
    return c
  }, [a])

  let body: React.ReactNode
  if (query.trim() || nFilters) {
    if (!scan) body = <p className="panel-empty">Reading files{indexing ? ` (${indexing.done} of ${indexing.total})` : ''}…</p>
    else if (query.trim())
      body = hits.length ? (
        <ul className="hits" aria-label="Search results">
          {hits.map((h) => (
            <li key={h.path}>
              <button type="button" className="hit" aria-current={h.path === current ? 'page' : undefined} onClick={() => props.onOpen(h.path, { terms: h.terms })}>
                <span className="hit-title"><Highlight text={h.title} terms={h.terms} /></span>
                <span className="hit-path">{h.path}</span>
                <span className="hit-snip"><Highlight text={h.snippet} terms={h.terms} /></span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="panel-empty">No files match “{query.trim()}”{nFilters ? ' with these filters' : ''}.</p>
    else
      body = filtered.length ? (
        <ul className="hits" aria-label="Files matching the filters">
          {filtered.map((d) => (
            <li key={d.path}>
              <button type="button" className="hit" aria-current={d.path === current ? 'page' : undefined} onClick={() => props.onOpen(d.path)}>
                <span className="hit-title">{d.title}</span>
                <span className="hit-path">{d.path}</span>
                <DocBadges d={d} />
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="panel-empty">No files match these filters.</p>
  } else if (shownTab === 'contents' && a?.nav) {
    body = <div className="tree-wrap"><NavTree sections={a.nav} current={current} onOpen={(p) => props.onOpen(p)} /></div>
  } else if (shownTab === 'checks') {
    body = a ? <Checks analysis={a} counts={counts} onOpen={props.onOpen} current={current} /> : <p className="panel-empty">Checking files…</p>
  } else {
    body = <div className="tree-wrap"><FileTree paths={ws.docs} current={current} onOpen={(p) => props.onOpen(p)} /></div>
  }

  const problems = counts.error + counts.warning
  return (
    <section className="panel panel--folder" aria-labelledby="folder-h">
      <div className="panel-top">
        <h2 id="folder-h" className="panel-h folder-h" title={ws.name}>
          <Icon name={ws.source === 'zip' ? 'archive' : 'folder'} /><span className="folder-name">{ws.name}</span>
          <span className="panel-count">{ws.docs.length}</span>
        </h2>
        <button type="button" className="link-btn" onClick={props.onClose}>Close</button>
      </div>

      {a?.okf && (
        <div className="bundle" title="This folder is an Open Knowledge Format bundle">
          <div className="bundle-top">
            <span className="bundle-tag">OKF bundle</span>
            <span className="bundle-ver">{a.okf.version ? `v${a.okf.version}` : 'version not declared'}</span>
          </div>
          {a.okf.title && <strong className="bundle-title">{a.okf.title}</strong>}
          {a.okf.description && <p className="bundle-desc">{a.okf.description}</p>}
          {a.okf.license && <p className="bundle-meta">License: {a.okf.license}</p>}
        </div>
      )}

      <div className="search-row">
        <div className="search">
          <Icon name="search" />
          <input
            ref={props.searchRef} type="search" placeholder="Search files" aria-label={`Search ${ws.name}`}
            value={query} onChange={(e) => props.onQuery(e.target.value)} spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && hits[0]) props.onOpen(hits[0].path, { terms: hits[0].terms })
              if (e.key === 'Escape' && query) { e.stopPropagation(); props.onQuery('') }
            }}
          />
        </div>
        <button
          type="button" className={'btn btn--icon btn--sm' + (nFilters ? ' is-on' : '')} aria-pressed={showFilters}
          onClick={() => setShowFilters((s) => !s)} title="Filter by frontmatter" aria-label={`Filters${nFilters ? ` (${nFilters} on)` : ''}`}
        >
          <Icon name="filter" />{nFilters ? <span className="dot-count">{nFilters}</span> : null}
        </button>
      </div>
      {showFilters && (a ? <FilterBar docs={a.docs} filters={filters} onChange={props.onFilters} /> : <p className="panel-empty">Reading files…</p>)}

      {ws.truncated && <p className="panel-note">Only the first {ws.files.size.toLocaleString()} files were read.</p>}

      {!query.trim() && !nFilters && (
        <div className="tabs" role="tablist" aria-label="Folder views">
          {a?.nav && <button type="button" role="tab" aria-selected={shownTab === 'contents'} onClick={() => setTab('contents')}>Contents</button>}
          <button type="button" role="tab" aria-selected={shownTab === 'files'} onClick={() => setTab('files')}>Files</button>
          <button type="button" role="tab" aria-selected={shownTab === 'checks'} onClick={() => setTab('checks')}>
            Checks{a ? <span className={'tab-count' + (counts.error ? ' is-error' : problems ? ' is-warn' : '')}>{problems || <Icon name="check" />}</span> : null}
          </button>
        </div>
      )}
      {body}
    </section>
  )
}

/* ---------- filters ---------- */

function FilterBar({ docs, filters, onChange }: { docs: Map<string, DocInfo>; filters: Filters; onChange: (f: Filters) => void }) {
  const f = useMemo(() => facetValues(docs.values()), [docs])
  const set = (k: keyof Filters, v: string) => onChange({ ...filters, [k]: v === '' ? undefined : k === 'changed' ? Number(v) : v })
  const select = (k: keyof Filters, label: string, opts: [string, string][]) => (
    <label className="filter">
      <span>{label}</span>
      <select value={(filters[k] as string | number | undefined) ?? ''} onChange={(e) => set(k, e.target.value)}>
        <option value="">Any</option>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  )
  const anyOkf = f.statuses.length > 0
  return (
    <div className="filters">
      {select('type', 'Type', f.types.map(([t, n]) => [t, `${t === NO_TYPE ? 'No type' : t} (${n})`]))}
      {anyOkf && select('status', 'Status', f.statuses.map(([t, n]) => [t, `${t} (${n})`]))}
      {f.tags.length > 0 && select('tag', 'Tag', f.tags.map(([t, n]) => [t, `${t} (${n})`]))}
      {anyOkf && select('tier', 'Trust', f.tiers.map(([t, n]) => [t, `${TIER_LABEL[t as TrustTier]} (${n})`]))}
      {f.withStale > 0 && select('fresh', 'Freshness', [['stale', `Stale (${f.stale})`], ['fresh', `Not stale yet (${f.withStale - f.stale})`]])}
      {f.dated > 0 && select('changed', 'Changed', [['7', 'In the last week'], ['30', 'In the last 30 days'], ['90', 'In the last 3 months'], ['365', 'In the last year']])}
      {activeCount(filters) > 0 && <button type="button" className="link-btn" onClick={() => onChange({})}>Clear filters</button>}
    </div>
  )
}

export function DocBadges({ d }: { d: DocInfo }) {
  const s = d.signals
  if (!s.type) return null
  return (
    <span className="badges">
      <span className="badge badge--type">{s.type}</span>
      {s.status && s.status !== 'stable' && <span className={'badge badge--' + s.status}>{s.status}</span>}
      {s.stale && <span className="badge badge--stale">stale</span>}
      {s.tier === 'human' && <span className="badge badge--ok">reviewed</span>}
    </span>
  )
}

/* ---------- index.md navigation ---------- */

function NavTree({ sections, current, onOpen, depth = 0 }: { sections: NavSection[]; current?: string; onOpen: (p: string) => void; depth?: number }) {
  const [closed, setClosed] = useState<Set<string>>(new Set())
  return (
    <div className="nav" style={{ paddingLeft: depth ? 12 : 0 }}>
      {sections.map((sec, si) => (
        <div key={si} className="nav-sec">
          {sec.heading && <div className="nav-h">{sec.heading}</div>}
          <ul>
            {sec.items.map((it, i) => {
              const key = si + ':' + i
              const open = !closed.has(key)
              return (
                <li key={key}>
                  <div className="nav-row">
                    {it.children?.length ? (
                      <button type="button" className={'tree-caret nav-caret' + (open ? ' is-open' : '')} aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}
                        onClick={() => setClosed((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })}>
                        <Icon name="chevron" />
                      </button>
                    ) : <span className="nav-spacer" />}
                    {it.path ? (
                      <button type="button" className="nav-item" aria-current={it.path === current ? 'page' : undefined} onClick={() => onOpen(it.path!)} title={it.desc ?? it.path}>
                        <span className="nav-title">{it.title}</span>
                        {it.desc && <span className="nav-desc">{it.desc}</span>}
                      </button>
                    ) : it.broken ? (
                      <span className="nav-item is-broken" title={`${it.href} isn't in the folder`}><span className="nav-title">{it.title}</span><span className="nav-desc">Missing: {it.href}</span></span>
                    ) : (
                      <a className="nav-item" href={it.href} target="_blank" rel="noopener noreferrer"><span className="nav-title">{it.title}</span>{it.desc && <span className="nav-desc">{it.desc}</span>}</a>
                    )}
                  </div>
                  {it.children?.length && open ? <NavTree sections={it.children} current={current} onOpen={onOpen} depth={depth + 1} /> : null}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

/* ---------- validator ---------- */

function IssueRow({ i, onOpen, showPath }: { i: Issue; onOpen: (p: string, o?: OpenOpts) => void; showPath?: boolean }) {
  const href = i.code === 'broken-link' ? /(?:Broken link: |Link to )(\S+)/.exec(i.message)?.[1] : undefined
  return (
    <li>
      <button type="button" className={'issue issue--' + i.level} onClick={() => onOpen(i.path, { href })}>
        <Icon name={i.level} />
        <span className="issue-text">
          {showPath && <span className="issue-path">{i.path}</span>}
          <span>{i.message}{i.line ? <span className="issue-line"> · line {i.line}</span> : null}</span>
        </span>
      </button>
    </li>
  )
}

function Checks({ analysis, counts, onOpen, current }: { analysis: Analysis; counts: Record<Level, number>; onOpen: (p: string, o?: OpenOpts) => void; current?: string }) {
  const [levels, setLevels] = useState<Set<Level>>(new Set(['error', 'warning']))
  const toggle = (l: Level) => setLevels((s) => { const n = new Set(s); n.has(l) ? n.delete(l) : n.add(l); return n })
  const byFile = useMemo(() => {
    const m = new Map<string, Issue[]>()
    for (const i of analysis.issues) if (levels.has(i.level)) { const l = m.get(i.path) ?? []; l.push(i); m.set(i.path, l) }
    return [...m]
  }, [analysis, levels])
  const concepts = [...analysis.docs.values()].filter((d) => d.concept).length
  return (
    <div className="checks">
      <p className="checks-sum">
        {analysis.okf
          ? <>Checked {concepts.toLocaleString()} OKF concept{concepts === 1 ? '' : 's'} and their links against the OKF {analysis.okf.version && parseFloat(analysis.okf.version) < 0.3 ? `v${analysis.okf.version}` : 'v0.3'} rules.</>
          : <>Not detected as an OKF bundle, so only links and frontmatter are checked.</>}
      </p>
      <div className="chips" role="group" aria-label="Show">
        {(['error', 'warning', 'info'] as Level[]).map((l) => (
          <button key={l} type="button" className={'chip chip--' + l} aria-pressed={levels.has(l)} onClick={() => toggle(l)}>
            <Icon name={l} />{plural(counts[l], l)}
          </button>
        ))}
      </div>
      {byFile.length === 0 ? (
        <p className="checks-ok"><Icon name="check" />{counts.error + counts.warning === 0 ? 'No problems found.' : 'Nothing to show with these filters.'}</p>
      ) : (
        <div className="hits">
          {byFile.map(([path, list]) => (
            <div key={path} className="check-file">
              <button type="button" className={'check-file-h' + (path === current ? ' is-current' : '')} onClick={() => onOpen(path)}>
                {analysis.docs.get(path)?.title ?? path}<span>{path}</span>
              </button>
              <ul>{list.map((i, k) => <IssueRow key={k} i={i} onOpen={onOpen} />)}</ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- the current file: links in, problems ---------- */

export function FileLinksPanel({ analysis, path, onOpen }: { analysis: Analysis; path: string; onOpen: (p: string, o?: OpenOpts) => void }) {
  const d = analysis.docs.get(path)
  if (!d) return null
  const back = analysis.backlinks.get(path) ?? []
  const issues = d.issues.filter((i) => i.level !== 'info' || i.code === 'unverified' || i.code === 'deprecated')
  return (
    <>
      {issues.length > 0 && (
        <section className="panel" aria-labelledby="fchk-h">
          <h2 id="fchk-h" className="panel-h">Checks for this file <span className="panel-count">{issues.length}</span></h2>
          <ul className="issues">{issues.map((i, k) => <IssueRow key={k} i={i} onOpen={onOpen} />)}</ul>
        </section>
      )}
      <section className="panel" aria-labelledby="back-h">
        <h2 id="back-h" className="panel-h">Linked from <span className="panel-count">{back.length}</span></h2>
        {back.length ? (
          <ul className="backlinks">
            {back.map((p) => (
              <li key={p}><button type="button" className="tree-row" onClick={() => onOpen(p)} title={p}><Icon name="link" /><span className="tree-label">{analysis.docs.get(p)?.title ?? p}</span></button></li>
            ))}
          </ul>
        ) : <p className="panel-empty">No other file links here.</p>}
      </section>
    </>
  )
}

/* ---------- recent ---------- */

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
            <button type="button" className="recent-item" onClick={() => onOpen(r)} title={r.kind !== 'file' && r.path ? `${r.name}/${r.path}` : r.name}>
              <Icon name={r.kind === 'folder' ? 'folder' : r.kind === 'zip' ? 'archive' : 'file'} />
              <span className="recent-text">
                <span className="recent-name">{r.name}</span>
                <span className="recent-meta">{r.kind === 'folder' ? 'Folder · ' : r.kind === 'zip' ? 'Zip · ' : ''}{ago(r.openedAt)}</span>
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
