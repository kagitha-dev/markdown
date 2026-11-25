import { useEffect, useMemo, useRef, useState } from 'react'
import type { Analysis } from './okf'

const LIGHT = ['#1d2bd8', '#c2410c', '#15803d', '#a21caf', '#0e7490', '#b45309', '#be123c', '#4d7c0f', '#6d28d9', '#0369a1']
const DARK = ['#8f99ff', '#fb923c', '#4ade80', '#e879f9', '#22d3ee', '#fbbf24', '#fb7185', '#a3e635', '#c4b5fd', '#7dd3fc']
const NONE_LIGHT = '#9aa0ad', NONE_DARK = '#5b6072'
const MAX_ALL = 1500

/** Map of how the folder's files link together. Colours show the OKF `type`; click a file to open it. */
export function GraphView(props: {
  analysis: Analysis
  current?: string
  match: ((path: string) => boolean) | null
  onOpen: (path: string) => void
  dark: boolean
}) {
  const { analysis, current, match, dark } = props
  const box = useRef<HTMLDivElement>(null)
  const cyRef = useRef<any>(null)
  const onOpen = useRef(props.onOpen)
  onOpen.current = props.onOpen
  const total = analysis.docs.size
  const [scope, setScope] = useState<'all' | 'near'>(() => (total > 300 ? 'near' : 'all'))
  const [orphans, setOrphans] = useState(true)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  // Edges between Markdown files (deduplicated), plus the type palette.
  const { edges, colors, types, degree } = useMemo(() => {
    const edges: [string, string][] = []
    const seen = new Set<string>()
    const degree = new Map<string, number>()
    for (const d of analysis.docs.values()) {
      for (const l of d.links) {
        if (!l.ok || !l.target || l.target === d.path || !analysis.docs.has(l.target)) continue
        const k = d.path + '\n' + l.target
        if (seen.has(k)) continue
        seen.add(k)
        edges.push([d.path, l.target])
        degree.set(d.path, (degree.get(d.path) ?? 0) + 1)
        degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
      }
    }
    const counts = new Map<string, number>()
    for (const d of analysis.docs.values()) if (d.signals.type) counts.set(d.signals.type, (counts.get(d.signals.type) ?? 0) + 1)
    const types = [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t)
    const pal = dark ? DARK : LIGHT
    const colors = new Map(types.map((t, i) => [t, i < pal.length ? pal[i] : dark ? NONE_DARK : NONE_LIGHT]))
    return { edges, colors, types, degree }
  }, [analysis, dark])

  // Which files are drawn.
  const nodes = useMemo(() => {
    let ids: string[]
    if (scope === 'near' && current && analysis.docs.has(current)) {
      const hop = (from: Set<string>) => {
        const out = new Set(from)
        for (const [a, b] of edges) { if (from.has(a)) out.add(b); if (from.has(b)) out.add(a) }
        return out
      }
      let near = hop(new Set([current]))
      if (near.size < 25) near = hop(near) // a second step for small neighbourhoods
      ids = [...near]
    } else ids = [...analysis.docs.keys()].slice(0, MAX_ALL)
    if (!orphans) ids = ids.filter((id) => (degree.get(id) ?? 0) > 0 || id === current)
    return ids
  }, [scope, current, analysis, edges, orphans, degree])

  /* Build the graph. In "all" mode it isn't rebuilt when the current file changes. */
  const rebuildKey = scope === 'near' ? current : 'all'
  useEffect(() => {
    let cancelled = false
    const el = box.current
    if (!el) return
    setState('loading')
    import('cytoscape').then(({ default: cytoscape }) => {
      if (cancelled) return
      const css = getComputedStyle(document.documentElement)
      const ink = css.getPropertyValue('--ink-2').trim() || '#4a4d57'
      const line = dark ? '#3a3f5c' : '#c9ccd6'
      const accent = css.getPropertyValue('--accent').trim() || '#1d2bd8'
      const bg = css.getPropertyValue('--bg').trim() || '#fff'
      const set = new Set(nodes)
      const cy = cytoscape({
        container: el,
        elements: [
          ...nodes.map((id) => {
            const d = analysis.docs.get(id)!
            const t = d.signals.type
            return {
              data: {
                id, label: d.title.length > 28 ? d.title.slice(0, 27) + '…' : d.title,
                color: t ? colors.get(t)! : dark ? NONE_DARK : NONE_LIGHT,
                size: 10 + Math.min(26, Math.sqrt(degree.get(id) ?? 0) * 6),
              },
              classes: [d.signals.status === 'deprecated' ? 'deprecated' : '', d.signals.stale ? 'stale' : ''].join(' '),
            }
          }),
          ...edges.filter(([a, b]) => set.has(a) && set.has(b)).map(([a, b], i) => ({ data: { id: 'e' + i, source: a, target: b } })),
        ],
        style: [
          { selector: 'node', style: {
            'background-color': 'data(color)', width: 'data(size)', height: 'data(size)', label: 'data(label)', 'min-zoomed-font-size': 7,
            'font-family': 'Inter, system-ui, sans-serif', 'font-size': 11, color: ink, 'text-valign': 'bottom', 'text-margin-y': 4,
            'text-background-color': bg, 'text-background-opacity': 0.75, 'text-background-padding': '1px', 'text-max-width': '120px',
            'border-width': 0, 'transition-property': 'opacity', 'transition-duration': 120,
          } as any },
          { selector: 'node.deprecated', style: { 'border-width': 2, 'border-style': 'dashed', 'border-color': ink, 'background-opacity': 0.35 } as any },
          { selector: 'node.stale', style: { shape: 'diamond' } },
          { selector: 'node.current', style: { 'border-width': 3, 'border-color': accent, label: 'data(label)', 'font-weight': 600, color: accent, 'z-index': 10 } as any },
          { selector: 'node.hl', style: { label: 'data(label)', 'z-index': 9 } as any },
          { selector: 'edge', style: {
            width: 1, 'line-color': line, 'curve-style': 'straight', 'target-arrow-shape': 'triangle',
            'target-arrow-color': line, 'arrow-scale': 0.6, opacity: 0.9,
          } as any },
          { selector: 'edge.hl', style: { 'line-color': accent, 'target-arrow-color': accent, width: 1.6, 'z-index': 8 } as any },
          { selector: '.faded', style: { opacity: 0.12 } },
          { selector: '.nomatch', style: { opacity: 0.15 } },
        ],
        layout: { name: 'cose', animate: false, nodeRepulsion: () => 60000, idealEdgeLength: () => 120, nodeOverlap: 40, componentSpacing: 90, padding: 30, randomize: true, numIter: nodes.length > 600 ? 600 : 1500 } as any,
        minZoom: 0.1, maxZoom: 3, wheelSensitivity: 0.25,
      })
      cy.on('tap', 'node', (e: any) => onOpen.current(e.target.id()))
      cy.on('mouseover', 'node', (e: any) => {
        const n = e.target.closedNeighborhood()
        cy.elements().not(n).addClass('faded')
        n.addClass('hl')
        el.style.cursor = 'pointer'
      })
      cy.on('mouseout', 'node', () => { cy.elements().removeClass('faded hl'); el.style.cursor = '' })
      // Fit the drawing, but don't blow small graphs up to giant labels.
      const fit = () => { cy.resize(); cy.fit(undefined, 40); if (cy.zoom() > 1.5) { cy.zoom(1.5); cy.center() } }
      requestAnimationFrame(fit)
      const ro = new ResizeObserver(() => fit())
      ro.observe(el)
      cy.one('destroy', () => ro.disconnect())
      cyRef.current = cy
      setState('ready')
    }, () => !cancelled && setState('error'))
    return () => { cancelled = true; cyRef.current?.destroy(); cyRef.current = null }
  }, [analysis, nodes.length, rebuildKey, orphans, dark, colors, edges]) // eslint-disable-line react-hooks/exhaustive-deps

  /* Mark the current file and files that don't match the filters, without a new layout. */
  useEffect(() => {
    const cy = cyRef.current
    if (!cy || state !== 'ready') return
    cy.nodes().removeClass('current nomatch')
    cy.edges().removeClass('nomatch')
    if (current) {
      const n = cy.getElementById(current)
      if (n.nonempty()) { n.addClass('current'); if (scope === 'all') cy.animate({ center: { eles: n } }, { duration: 200 }) }
    }
    if (match) cy.nodes().forEach((n: any) => { if (!match(n.id())) { n.addClass('nomatch'); n.connectedEdges().addClass('nomatch') } })
  }, [current, match, state, scope])

  const shown = types.slice(0, 10)
  return (
    <div className="graph">
      <div className="graph-bar">
        <div className="seg seg--sm" role="group" aria-label="Files shown">
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All files</button>
          <button type="button" aria-pressed={scope === 'near'} onClick={() => setScope('near')} disabled={!current}>Near this file</button>
        </div>
        <label className="graph-check"><input type="checkbox" checked={orphans} onChange={(e) => setOrphans(e.target.checked)} /> Unlinked files</label>
        <span className="graph-count">
          {nodes.length.toLocaleString()} file{nodes.length === 1 ? '' : 's'}
          {scope === 'all' && total > MAX_ALL ? ` of ${total.toLocaleString()}` : ''}
        </span>
        <button type="button" className="link-btn" onClick={() => { const cy = cyRef.current; if (!cy) return; cy.fit(undefined, 40); if (cy.zoom() > 1.5) { cy.zoom(1.5); cy.center() } }}>Fit</button>
      </div>
      <div className="graph-canvas" ref={box} aria-label="Graph of links between files. Use the file tree to open files with the keyboard." role="img" />
      {state === 'loading' && <p className="graph-msg">Laying out the graph…</p>}
      {state === 'error' && <p className="graph-msg">The graph couldn't be drawn.</p>}
      {state === 'ready' && !edges.length && <p className="graph-msg">These files don't link to each other yet.</p>}
      <div className="graph-legend">
        {shown.map((t) => <span key={t}><i style={{ background: colors.get(t) }} />{t}</span>)}
        {types.length > shown.length && <span><i style={{ background: dark ? NONE_DARK : NONE_LIGHT }} />other types</span>}
        <span><i style={{ background: dark ? NONE_DARK : NONE_LIGHT }} />no type</span>
        <span><i className="lg-diamond" />stale</span>
        <span><i className="lg-dashed" />deprecated</span>
      </div>
    </div>
  )
}
