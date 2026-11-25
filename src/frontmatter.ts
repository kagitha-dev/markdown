import { parseDocument } from 'yaml'

/* ---------- Frontmatter ---------- */

export type FmValue = string | number | boolean | null | FmValue[] | { [k: string]: FmValue }

export interface Frontmatter {
  raw: string
  data: Record<string, FmValue> | null
  error: { message: string; line?: number } | null
  /** line count of the frontmatter block incl. fences, for source view offsets */
  lines: number
}

const FM_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

export function extractFrontmatter(src: string): Frontmatter | null {
  const m = FM_RE.exec(src)
  if (!m) return null
  const raw = m[1]
  const lines = m[0].split('\n').length - (m[0].endsWith('\n') ? 1 : 0)
  const doc = parseDocument(raw, { prettyErrors: true })
  if (doc.errors.length) {
    const e = doc.errors[0]
    const line = e.linePos?.[0]?.line
    return { raw, data: null, lines, error: { message: e.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, ''), line: line ? line + 1 : undefined } }
  }
  const js = doc.toJS() as unknown
  if (js === null || js === undefined) return { raw, data: {}, lines, error: null }
  if (typeof js !== 'object' || Array.isArray(js))
    return { raw, data: null, lines, error: { message: 'Frontmatter must be a set of key: value pairs' } }
  return { raw, data: normalize(js) as Record<string, FmValue>, lines, error: null }
}

function normalize(v: unknown): FmValue {
  if (v instanceof Date) return isNaN(+v) ? String(v) : v.toISOString().replace(/T00:00:00\.000Z$/, '')
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    const o: Record<string, FmValue> = {}
    for (const [k, x] of Object.entries(v)) o[k] = normalize(x)
    return o
  }
  if (v === undefined) return null
  return v as FmValue
}

export function docStats(src: string) {
  const body = src.replace(FM_RE, '').replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`~\-|[\]()!]/g, ' ')
  const words = body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  return { words, minutes: Math.max(1, Math.round(words / 220)) }
}
