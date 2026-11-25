/* Reads every Markdown file in an opened folder once, then builds the search index and the OKF analysis. */
import { analyze, type Analysis } from './okf'
import { buildIndex, type SearchIndex } from './search'
import type { Workspace } from './workspace'

export interface Scan { index: SearchIndex; analysis: Analysis; texts: Map<string, string> }
const MAX_BYTES = 2_000_000

export async function scanFolder(ws: Workspace, onProgress?: (done: number, total: number) => void, job?: { cancelled: boolean }): Promise<Scan | null> {
  const texts = new Map<string, string>()
  const docs = ws.docs
  for (let i = 0; i < docs.length; i++) {
    if (job?.cancelled) return null
    try {
      const f = await ws.files.get(docs[i])!.get()
      if (f.size <= MAX_BYTES) texts.set(docs[i], await f.text())
    } catch { /* unreadable file: skip */ }
    if (i % 25 === 24) { onProgress?.(i + 1, docs.length); await new Promise((r) => setTimeout(r, 0)) }
  }
  onProgress?.(docs.length, docs.length)
  return rescan(ws, texts)
}

/** Rebuild from texts already read. */
export function rescan(ws: Workspace, texts: Map<string, string>): Scan {
  const analysis = analyze(ws, texts)
  const titles = new Map<string, string>()
  const meta = new Map<string, string>()
  for (const d of analysis.docs.values()) {
    titles.set(d.path, d.title)
    meta.set(d.path, [d.signals.type, ...d.signals.tags, d.description].filter(Boolean).join(' '))
  }
  return { index: buildIndex(texts, titles, meta), analysis, texts }
}
