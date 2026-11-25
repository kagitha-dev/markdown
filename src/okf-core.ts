/*
 * Open Knowledge Format (OKF) signals derived from one concept's frontmatter.
 * Follows OKF v0.3 (Nov 2026) with the v0.2 and v0.1 fallbacks the spec documents.
 * Nothing here rejects a file: OKF consumers must be lenient, so problems become notes.
 */
import type { FmValue } from './frontmatter'

export type TrustTier = 'unverified' | 'machine' | 'human' | 'outdated'
export type Status = 'draft' | 'stable' | 'deprecated'
export const RESERVED = new Set(['index.md', 'log.md'])

export interface OkfSignals {
  type: string | null
  status: Status | null
  /** the raw status when it isn't one of the three defined values */
  badStatus?: string
  tier: TrustTier
  lastVerified: Date | null
  generatedAt: Date | null
  generatedBy: string | null
  staleAfter: Date | null
  stale: boolean
  supersededBy: string | null
  /** generated.at, or legacy `timestamp`, or common date fields: when the content last changed */
  changed: Date | null
  tags: string[]
}

type Obj = Record<string, FmValue>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)

export function parseDate(v: unknown): Date | null {
  const s = str(v)
  if (!s) return null
  // A bare date means the start of that day in UTC, as YAML 1.2 timestamps do.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s)
  return isNaN(+d) ? null : d
}

/** `verified` may be a single mapping or a list (consumers MUST accept both). */
export function verifiedList(v: unknown): { by: string | null; at: Date | null; raw: unknown }[] {
  if (v === null || v === undefined || v === '') return []
  const list = Array.isArray(v) ? v : [v]
  return list.map((e) => (isObj(e) ? { by: str(e.by), at: parseDate(e.at), raw: e } : { by: str(e), at: null, raw: e }))
}

export function okfSignals(data: Obj | null | undefined, now = new Date()): OkfSignals {
  const d = data ?? {}
  const type = str(d.type)
  const rawStatus = str(d.status)?.toLowerCase() ?? null
  const status = rawStatus === 'draft' || rawStatus === 'stable' || rawStatus === 'deprecated' ? rawStatus : rawStatus ? null : null
  const gen = isObj(d.generated) ? d.generated : null
  const generatedAt = parseDate(gen?.at) ?? (gen ? null : parseDate(d.timestamp))
  const ver = verifiedList(d.verified)
  // v0.3: only verifications at or after generated.at count toward the tier.
  const current = ver.filter((v) => !generatedAt || (v.at && v.at >= generatedAt))
  const tier: TrustTier = !ver.length
    ? 'unverified'
    : current.some((v) => v.by?.startsWith('human:'))
      ? 'human'
      : current.length
        ? 'machine'
        : 'outdated'
  const lastVerified = ver.reduce<Date | null>((m, v) => (v.at && (!m || v.at > m) ? v.at : m), null)
  const staleAfter = parseDate(d.stale_after)
  const changed = generatedAt ?? parseDate(d.updated) ?? parseDate(d.last_updated) ?? parseDate(d.modified) ?? parseDate(d.date) ?? parseDate(d.created)
  const tags = Array.isArray(d.tags) ? d.tags.map(str).filter((t): t is string => !!t) : str(d.tags) ? [str(d.tags)!] : []
  return {
    type,
    status: rawStatus ? status : null,
    badStatus: rawStatus && !status ? rawStatus : undefined,
    tier,
    lastVerified,
    generatedAt,
    generatedBy: str(gen?.by),
    staleAfter,
    stale: !!staleAfter && now >= staleAfter,
    supersededBy: str(d.superseded_by),
    changed,
    tags,
  }
}

export const TIER_LABEL: Record<TrustTier, string> = {
  unverified: 'Unverified',
  machine: 'Machine-confirmed',
  human: 'Human-reviewed',
  outdated: 'Verification out of date',
}

export function relDate(d: Date, now = new Date()) {
  const days = Math.round((+d - +now) / 86_400_000)
  const abs = Math.abs(days)
  const fmt = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  if (abs === 0) return `${fmt} (today)`
  const span = abs < 60 ? `${abs} day${abs === 1 ? '' : 's'}` : abs < 730 ? `${Math.round(abs / 30)} months` : `${Math.round(abs / 365)} years`
  return `${fmt} (${days < 0 ? span + ' ago' : 'in ' + span})`
}
