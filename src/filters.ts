import type { DocInfo } from './okf'
import type { TrustTier } from './okf-core'

export interface Filters {
  type?: string
  status?: string
  tag?: string
  tier?: TrustTier
  fresh?: 'stale' | 'fresh'
  /** changed within this many days */
  changed?: number
}

export const NO_TYPE = '(no type)'
export const activeCount = (f: Filters) => Object.values(f).filter((v) => v !== undefined && v !== '').length

export function matches(d: DocInfo, f: Filters, now = Date.now()) {
  const s = d.signals
  if (f.type && (s.type ?? NO_TYPE) !== f.type) return false
  // An absent status means stable (OKF spec), for files that are concepts.
  if (f.status && (s.status ?? (s.type ? 'stable' : '')) !== f.status) return false
  if (f.tag && !s.tags.includes(f.tag)) return false
  if (f.tier && (!s.type || s.tier !== f.tier)) return false
  if (f.fresh === 'stale' && !s.stale) return false
  if (f.fresh === 'fresh' && (s.stale || !s.staleAfter)) return false
  if (f.changed && (!s.changed || now - +s.changed > f.changed * 86_400_000)) return false
  return true
}

/** The values present in the folder, with counts, for the filter menus. */
export function facetValues(docs: Iterable<DocInfo>) {
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
  const types = new Map<string, number>(), statuses = new Map<string, number>(), tags = new Map<string, number>(), tiers = new Map<string, number>()
  let stale = 0, withStale = 0, dated = 0
  for (const d of docs) {
    const s = d.signals
    count(types, s.type ?? NO_TYPE)
    if (s.type) { count(statuses, s.status ?? 'stable'); count(tiers, s.tier) }
    s.tags.forEach((t) => count(tags, t))
    if (s.staleAfter) { withStale++; if (s.stale) stale++ }
    if (s.changed) dated++
  }
  const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return { types: sorted(types), statuses: sorted(statuses), tags: sorted(tags).slice(0, 60), tiers: sorted(tiers), stale, withStale, dated }
}
