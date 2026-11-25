import MiniSearch from 'minisearch'
import { extractFrontmatter } from './frontmatter'
import type { Workspace } from './workspace'

export interface Hit { path: string; title: string; snippet: string; terms: string[] }
export interface SearchIndex {
  search(q: string): Hit[]
  /** Text of every indexed file, also used to show the first match. */
  texts: Map<string, string>
}

const MAX_INDEX_BYTES = 2_000_000

function plain(md: string) {
  return md
    .replace(/^﻿?---[\s\S]*?\n(?:---|\.\.\.)\s*\n/, '')
    .replace(/```[^\n]*\n/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`~|]+/g, ' ')
}

function titleOf(path: string, text: string) {
  const fm = extractFrontmatter(text)
  const t = fm?.data?.title
  if (typeof t === 'string' && t.trim()) return t.trim()
  const h = /^#\s+(.+)$/m.exec(text)
  return h ? h[1].replace(/[*_`]/g, '').trim() : path.slice(path.lastIndexOf('/') + 1)
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

/** Reads every Markdown file in the folder and builds a full-text index, reporting progress. */
export async function buildIndex(ws: Workspace, onProgress?: (done: number, total: number) => void, signal?: { cancelled: boolean }): Promise<SearchIndex> {
  const mini = new MiniSearch<{ id: string; title: string; path: string; body: string }>({
    fields: ['title', 'path', 'body'],
    storeFields: ['title'],
    searchOptions: { boost: { title: 3, path: 1.5 }, prefix: true, fuzzy: 0.15, combineWith: 'AND' },
  })
  const texts = new Map<string, string>()
  const docs = ws.docs
  const batch: { id: string; title: string; path: string; body: string }[] = []
  for (let i = 0; i < docs.length; i++) {
    if (signal?.cancelled) break
    const path = docs[i]
    try {
      const f = await ws.files.get(path)!.get()
      if (f.size <= MAX_INDEX_BYTES) {
        const text = await f.text()
        texts.set(path, text)
        batch.push({ id: path, title: titleOf(path, text), path: path.replace(/[/._-]/g, ' '), body: plain(text) })
      }
    } catch { /* unreadable file: skip */ }
    if (i % 25 === 24) { onProgress?.(i + 1, docs.length); await new Promise((r) => setTimeout(r, 0)) }
  }
  mini.addAll(batch)
  onProgress?.(docs.length, docs.length)
  return {
    texts,
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
