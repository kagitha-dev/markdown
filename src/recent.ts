import { createStore, get, set, del } from 'idb-keyval'

/** Recently opened files and folders, kept only in this browser (IndexedDB). */
export interface RecentEntry {
  id: string
  kind: 'file' | 'folder'
  name: string
  openedAt: number
  /** For single files: a copy of the text, so it can be reopened without the original. */
  text?: string
  /** For folders opened with the File System Access API. */
  handle?: FileSystemDirectoryHandle
  /** For folders: the file that was open last. */
  path?: string
}

const KEY = 'recent'
const MAX = 12
const MAX_TEXT = 500_000
let store: ReturnType<typeof createStore> | null = null
const db = () => (store ??= createStore('kmv', 'kv'))

export async function listRecent(): Promise<RecentEntry[]> {
  try { return ((await get<RecentEntry[]>(KEY, db())) ?? []).sort((a, b) => b.openedAt - a.openedAt) }
  catch { return [] }
}

export async function addRecent(entry: Omit<RecentEntry, 'id' | 'openedAt'>): Promise<RecentEntry[]> {
  if (entry.kind === 'file' && (entry.text?.length ?? 0) > MAX_TEXT) return listRecent()
  const list = await listRecent()
  let id = entry.kind + ':' + entry.name
  // Two different folders can share a name; keep both when the handles differ.
  if (entry.handle) {
    for (const r of list) {
      if (r.kind === 'folder' && r.handle && (await r.handle.isSameEntry(entry.handle).catch(() => false))) { id = r.id; break }
      if (r.id === id) id += ':' + Date.now()
    }
  }
  const next = [{ ...entry, id, openedAt: Date.now() }, ...list.filter((r) => r.id !== id)].slice(0, MAX)
  try { await set(KEY, next, db()) } catch { /* storage unavailable */ }
  return next
}

/** Remember which file was open in a folder. */
export async function touchFolderPath(handle: FileSystemDirectoryHandle, path: string) {
  const list = await listRecent()
  for (const r of list) {
    if (r.kind === 'folder' && r.handle && (await r.handle.isSameEntry(handle).catch(() => false))) {
      r.path = path
      try { await set(KEY, list, db()) } catch { /* ignore */ }
      return
    }
  }
}

export async function removeRecent(id: string): Promise<RecentEntry[]> {
  const next = (await listRecent()).filter((r) => r.id !== id)
  try { await set(KEY, next, db()) } catch { /* ignore */ }
  return next
}

export async function clearRecent() {
  try { await del(KEY, db()) } catch { /* ignore */ }
}
