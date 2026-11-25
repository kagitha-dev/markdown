import MiniSearch from 'minisearch'

export interface Hit { path: string; title: string; snippet: string; terms: string[] }
export interface SearchIndex { search(q: string): Hit[] }

export function plain(md: string) {
  return md
    .replace(/^﻿?---[\s\S]*?\n(?:---|\.\.\.)\s*\n/, '')
    .replace(/```[^\n]*\n/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`~|]+/g, ' ')
}

function snippetFor(text: string, terms: string[]) {
  const flat = plain(text).replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()
  let at = -1
  for (const t of terms) { const i = lower.indexOf(t.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i }
  if (at < 0) return flat.slice(0, 140)
  const start = Math.max(0, at - 50)
  return (start > 0 ? '…' : '') + flat.slice(start, start + 160).trim() + (start + 160 < flat.length ? '…' : '')
}

/** Full-text index over the folder's files (title boosted, prefix and light fuzzy matching). */
export function buildIndex(texts: Map<string, string>, titles: Map<string, string>, extra?: Map<string, string>): SearchIndex {
  const mini = new MiniSearch<{ id: string; title: string; path: string; body: string; meta: string }>({
    fields: ['title', 'path', 'body', 'meta'],
    storeFields: ['title'],
    searchOptions: { boost: { title: 3, path: 1.5, meta: 1.5 }, prefix: true, fuzzy: 0.15, combineWith: 'AND' },
  })
  mini.addAll([...texts].map(([path, text]) => ({
    id: path,
    title: titles.get(path) ?? path,
    path: path.replace(/[/._-]/g, ' '),
    body: plain(text),
    meta: extra?.get(path) ?? '',
  })))
  return {
    search(q: string) {
      if (!q.trim()) return []
      return mini.search(q).slice(0, 50).map((r) => ({
        path: r.id as string,
        title: r.title as string,
        terms: r.terms,
        snippet: snippetFor(texts.get(r.id as string) ?? '', r.terms),
      }))
    },
  }
}
