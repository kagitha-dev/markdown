/*
 * Folder analysis: OKF bundle detection, navigation from index.md, links and backlinks,
 * and the validator. Loaded on demand. Rules follow OKF v0.3 (Nov 2026) with v0.2 fallbacks.
 * Per the spec nothing is ever rejected; problems are reported as errors, warnings or notes.
 */
import { z } from 'zod'
import { extractFrontmatter, type FmValue } from './frontmatter'
import { okfSignals, parseDate, RESERVED, TIER_LABEL, relDate, type OkfSignals } from './okf-core'
import { dirOf, findFile, resolveLink, type Workspace } from './workspace'

export type Level = 'error' | 'warning' | 'info'
export interface Issue { path: string; level: Level; code: string; message: string; line?: number }
export interface LinkRef { href: string; line: number; target: string | null; ok: boolean }
export interface DocInfo {
  path: string
  title: string
  description: string | null
  data: Record<string, FmValue> | null
  yamlError: boolean
  signals: OkfSignals
  /** An OKF concept: a non-reserved file whose frontmatter has a `type`. */
  concept: boolean
  links: LinkRef[]
  issues: Issue[]
}
export interface NavItem { title: string; desc?: string; path?: string; dir?: string; broken?: boolean; href: string; children?: NavSection[] }
export interface NavSection { heading: string; items: NavItem[] }
export interface BundleInfo { version: string | null; title: string | null; description: string | null; license: string | null; declared: boolean }
export interface Analysis {
  okf: BundleInfo | null
  docs: Map<string, DocInfo>
  backlinks: Map<string, string[]>
  issues: Issue[]
  nav: NavSection[] | null
}

const isLocal = (u: string) => !!u && !u.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//')

/* ---------- links in a Markdown body ---------- */

/** Local links and images in a Markdown file, with 1-based line numbers. Code is ignored. */
export function extractLinks(text: string): { href: string; line: number }[] {
  const out: { href: string; line: number }[] = []
  let fence: string | null = null
  const lines = text.split('\n')
  const fm = /^﻿?---[ \t]*\r?$/.test(lines[0] ?? '') ? lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*\r?$/.test(l)) : -1
  lines.forEach((raw, i) => {
    if (i <= fm) return
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(raw)
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return }
    if (fence || /^( {4}|\t)/.test(raw)) return
    const line = raw.replace(/`+[^`]*`+/g, '')
    const push = (h: string) => { const href = h.trim().replace(/^<|>$/g, ''); if (isLocal(href)) out.push({ href, line: i + 1 }) }
    for (const m of line.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) push(m[1])
    const def = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line)
    if (def) push(def[1])
    for (const m of line.matchAll(/<(?:a|img)\b[^>]*?\s(?:href|src)\s*=\s*["']([^"']+)["']/gi)) push(m[1])
  })
  return out
}

/* ---------- frontmatter schema (lenient: problems become warnings) ---------- */

const dateish = z.union([z.string(), z.number()]).refine((v) => parseDate(v) !== null, { message: 'not-a-date' })
const actor = z.string().trim().min(1)
const event = z.looseObject({ by: actor, at: dateish })
const schema = z.looseObject({
  type: z.string().trim().min(1),
  status: z.string().trim().toLowerCase().pipe(z.enum(['draft', 'stable', 'deprecated'])).optional(),
  stale_after: dateish.optional(),
  generated: z.looseObject({ by: actor, at: dateish.optional() }).optional(),
  verified: z.union([event, z.array(event)]).optional(),
  sources: z.array(z.looseObject({ resource: z.string().trim().min(1) })).optional(),
  superseded_by: z.string().trim().min(1).optional(),
  runtime: z.string().optional(),
  tags: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).optional(),
})

/** Nulls and empty strings count as absent (v0.3: consumers accept them). */
function dropEmpty(d: Record<string, FmValue>) {
  const o: Record<string, FmValue> = {}
  for (const [k, v] of Object.entries(d)) if (v !== null && v !== '') o[k] = v
  return o
}

function schemaMessage(path: PropertyKey[], data: Record<string, FmValue>): { code: string; message: string; level: Level } {
  const [k, i, f] = path as (string | number)[]
  const n = typeof i === 'number' ? ` ${i + 1}` : ''
  switch (k) {
    case 'type': return { code: 'no-type', level: 'warning', message: 'Missing `type`, the one field OKF requires' }
    case 'status': return { code: 'bad-status', level: 'warning', message: `\`status\` should be draft, stable or deprecated (it is “${String(data.status)}”)` }
    case 'stale_after': return { code: 'bad-date', level: 'warning', message: '`stale_after` is not a date' }
    case 'generated': return i === 'by'
      ? { code: 'generated-no-by', level: 'warning', message: '`generated` has no `by` (who or what produced it)' }
      : { code: 'bad-date', level: 'warning', message: i === 'at' ? '`generated.at` is not a date' : '`generated` should be a mapping with `by` and `at`' }
    case 'verified': {
      const field = typeof i === 'number' ? f : i
      return { code: 'bad-verified', level: 'warning', message: field === 'by' ? `\`verified\` entry${n} has no \`by\`` : field === 'at' ? `\`verified\` entry${n} has no valid \`at\` date` : '`verified` should be `{by, at}` or a list of them' }
    }
    case 'sources': return { code: 'source-no-resource', level: 'warning', message: typeof i === 'number' ? `\`sources\` entry${n} has no \`resource\`` : '`sources` should be a list' }
    case 'superseded_by': return { code: 'bad-superseded', level: 'warning', message: '`superseded_by` should be a path to the replacement' }
    default: return { code: 'schema', level: 'warning', message: `\`${path.join('.')}\` has an unexpected value` }
  }
}

/* ---------- index.md navigation ---------- */

function parseIndex(text: string) {
  const sections: { heading: string; items: { title: string; href: string; desc?: string }[] }[] = []
  const body = text.replace(/^﻿?---[\s\S]*?\n(?:---|\.\.\.)[ \t]*\n/, '')
  for (const line of body.split('\n')) {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) { sections.push({ heading: h[1], items: [] }); continue }
    const e = /^\s*[*+-]\s+\[([^\]]+)\]\(\s*<?([^)\s>]+)>?[^)]*\)\s*(?:[-–—:]\s*(.*))?$/.exec(line)
    if (e) {
      if (!sections.length) sections.push({ heading: '', items: [] })
      sections[sections.length - 1].items.push({ title: e[1], href: e[2], desc: e[3]?.trim() || undefined })
    }
  }
  return sections.filter((s) => s.items.length)
}

/* ---------- analysis ---------- */

export function analyze(ws: Workspace, texts: Map<string, string>, now = new Date()): Analysis {
  const rootIndex = ws.files.has('index.md') ? 'index.md' : null
  const rootFm = rootIndex && texts.has(rootIndex) ? extractFrontmatter(texts.get(rootIndex)!) : null
  const declared = typeof rootFm?.data?.okf_version === 'string' || typeof rootFm?.data?.okf_version === 'number'
  const version = declared ? String(rootFm!.data!.okf_version) : null
  const v03 = !!version && parseFloat(version) >= 0.3
  const rootFallback = !v03

  const docs = new Map<string, DocInfo>()
  for (const [path, text] of texts) {
    const fm = extractFrontmatter(text)
    const data = fm?.data ?? null
    const name = path.slice(path.lastIndexOf('/') + 1)
    const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.replace(/[*_`]/g, '').trim()
    const signals = okfSignals(data, now)
    const reserved = RESERVED.has(name.toLowerCase())
    docs.set(path, {
      path,
      title: (typeof data?.title === 'string' && data.title.trim()) || h1 || name.replace(/\.(md|markdown|mdx?)$/i, ''),
      description: typeof data?.description === 'string' ? data.description : null,
      data,
      yamlError: !!fm?.error,
      signals,
      concept: !reserved && !!signals.type,
      links: [],
      issues: [],
    })
  }

  // A folder is treated as an OKF bundle if its root index.md declares okf_version,
  // or if most of its Markdown files carry a `type`.
  const candidates = [...docs.values()].filter((d) => !RESERVED.has(d.path.slice(d.path.lastIndexOf('/') + 1).toLowerCase()))
  const typed = candidates.filter((d) => d.concept).length
  const isOkf = declared || (typed >= 2 && typed >= candidates.length * 0.5)
  const okf: BundleInfo | null = isOkf
    ? {
        version, declared,
        title: typeof rootFm?.data?.title === 'string' ? rootFm.data.title : null,
        description: typeof rootFm?.data?.description === 'string' ? rootFm.data.description : null,
        license: typeof rootFm?.data?.license === 'string' ? rootFm.data.license : null,
      }
    : null

  const backlinks = new Map<string, string[]>()
  const exists = (from: string, href: string) => resolveLink(ws, from, href, isOkf && rootFallback)

  for (const d of docs.values()) {
    const add = (level: Level, code: string, message: string, line?: number) => d.issues.push({ path: d.path, level, code, message, line })
    const text = texts.get(d.path)!
    const name = d.path.slice(d.path.lastIndexOf('/') + 1).toLowerCase()
    const reserved = RESERVED.has(name)

    // Links (every folder)
    for (const l of extractLinks(text)) {
      const { target, file } = exists(d.path, l.href)
      d.links.push({ href: l.href, line: l.line, target: file?.path ?? target, ok: !!file })
      if (file) {
        if (file.kind === 'md' && file.path !== d.path) {
          const list = backlinks.get(file.path) ?? []
          if (!list.includes(d.path)) list.push(d.path)
          backlinks.set(file.path, list)
        }
      } else add('warning', 'broken-link', target === null ? `Link to ${l.href} points outside the folder` : `Broken link: ${l.href}`, l.line)
    }

    const fm = extractFrontmatter(text)
    if (fm?.error) { add('error', 'yaml', `Frontmatter can't be read: ${fm.error.message}`, fm.error.line); continue }
    if (!isOkf) continue

    // Reserved files
    if (reserved) {
      if (d.signals.type) add('warning', 'reserved', `${name} is reserved for ${name === 'index.md' ? 'listings' : 'the update log'} and shouldn't be a concept (it has a \`type\`)`)
      if (name === 'log.md') {
        text.split('\n').forEach((line, i) => {
          const m = /^##\s+(.+?)\s*$/.exec(line)
          if (m && !/^\d{4}-\d{2}-\d{2}$/.test(m[1])) add('warning', 'log-date', `Log heading “${m[1]}” should be a date like 2026-11-25`, i + 1)
        })
      }
      continue
    }

    // Concepts
    if (!fm || !d.data) {
      if (v03) add('info', 'not-concept', 'No frontmatter, so OKF tools skip this file')
      else add('warning', 'no-type', 'No frontmatter: OKF concepts need a `type`')
      continue
    }
    const data = dropEmpty(d.data)
    if (!d.signals.type && v03 && Object.keys(data).length === 0) { add('info', 'not-concept', 'No `type`, so OKF tools skip this file'); continue }
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      const seen = new Set<string>()
      for (const iss of parsed.error.issues) {
        const m = schemaMessage(iss.path, data)
        if (seen.has(m.message)) continue
        seen.add(m.message)
        add(m.level, m.code, m.message)
      }
    }
    const s = d.signals
    if (!s.type) continue

    if (s.stale && s.staleAfter) add('warning', 'stale', `Stale since ${relDate(s.staleAfter, now)}`)
    if (s.status === 'deprecated') {
      if (!s.supersededBy) add('info', 'deprecated', 'Deprecated, with no `superseded_by` pointing to a replacement')
      else add('info', 'deprecated', `Deprecated, replaced by ${s.supersededBy}`)
    }
    if (s.tier === 'unverified') add('info', 'unverified', 'Unverified: no `verified` entry (lowest trust tier)')
    else if (s.tier === 'outdated') add('warning', 'verify-outdated', 'Verified before the content last changed (`generated.at`), so the verification no longer counts')
    if (/^attested computation$/i.test(s.type) && !(typeof data.runtime === 'string' && data.runtime.trim()))
      add('warning', 'no-runtime', 'Attested Computations need a `runtime`')

    // Path-valued fields
    const pathFields: [string, unknown][] = [
      ['superseded_by', data.superseded_by], ['resource', data.resource], ['computation', data.computation],
      ['executor.resource', (data.executor as any)?.resource], ['attester.resource', (data.attester as any)?.resource],
      ...(Array.isArray(data.sources) ? data.sources.map((x, i) => [`sources ${i + 1} resource`, (x as any)?.resource] as [string, unknown]) : []),
    ]
    for (const [field, v] of pathFields) {
      if (typeof v !== 'string' || !isLocal(v.trim()) || /\s/.test(v.trim())) continue
      const { file } = exists(d.path, v.trim())
      if (!file) add('warning', 'broken-path', `\`${field}\` points to ${v.trim()}, which isn't in the bundle`)
      else if (field === 'superseded_by' && file.kind === 'md') {
        const list = backlinks.get(file.path) ?? []
        if (!list.includes(d.path)) list.push(d.path)
        backlinks.set(file.path, list)
      }
    }
  }

  // Navigation from index.md files
  let nav: NavSection[] | null = null
  if (rootIndex && texts.has(rootIndex)) {
    const seen = new Set<string>()
    const build = (indexPath: string, depth: number): NavSection[] => {
      seen.add(indexPath)
      return parseIndex(texts.get(indexPath) ?? '').map((sec) => ({
        heading: sec.heading,
        items: sec.items.map((it): NavItem => {
          if (!isLocal(it.href)) return { title: it.title, desc: it.desc, href: it.href }
          const { file, target } = exists(indexPath, it.href)
          const isDir = it.href.split(/[?#]/)[0].endsWith('/')
          if (!file) {
            // Already reported as a broken link in index.md; shown crossed out in Contents.
            return { title: it.title, desc: it.desc, href: it.href, broken: true }
          }
          const sub = isDir || /(^|\/)index\.md$/i.test(file.path) ? file.path : null
          return {
            title: it.title,
            desc: it.desc ?? docs.get(file.path)?.description ?? undefined,
            href: it.href,
            path: file.path,
            dir: isDir ? (target ?? dirOf(file.path)) : undefined,
            children: sub && depth < 6 && !seen.has(sub) && texts.has(sub) ? build(sub, depth + 1) : undefined,
          }
        }),
      }))
    }
    const secs = build(rootIndex, 0)
    nav = secs.length ? secs : null
  }

  const issues = [...docs.values()].flatMap((d) => d.issues)
  return { okf, docs, backlinks, issues, nav }
}

export { TIER_LABEL, findFile }
