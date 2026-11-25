/* An opened folder: every file in it, by path relative to the folder ("docs/intro.md"). */

export interface WsFile {
  path: string
  name: string
  kind: 'md' | 'image' | 'other'
  get(): Promise<File>
}

export interface Workspace {
  /** Unique per opened folder, so history entries can tell folders apart. */
  id: number
  name: string
  files: Map<string, WsFile>
  /** Present when the folder came from the File System Access API, so it can be reopened later. */
  handle?: FileSystemDirectoryHandle
  /** Markdown files, sorted by path. */
  docs: string[]
  /** Where the files came from, when not a folder on disk. */
  source?: 'zip'
  /** True when the folder had more than MAX_FILES files and only the first were read. */
  truncated: boolean
}

const MD_RE = /\.(md|markdown|mdown|mkd|mdx|txt)$/i
const IMG_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.next', 'dist', 'build', '.cache'])
export const MAX_FILES = 5000

export const isMarkdownName = (n: string) => MD_RE.test(n)
const kindOf = (n: string): WsFile['kind'] => (MD_RE.test(n) ? 'md' : IMG_RE.test(n) ? 'image' : 'other')
const skipDir = (n: string) => n.startsWith('.') || SKIP_DIRS.has(n)

let nextId = 1
function finish(name: string, files: Map<string, WsFile>, handle?: FileSystemDirectoryHandle): Workspace {
  const docs = [...files.values()].filter((f) => f.kind === 'md').map((f) => f.path).sort(comparePaths)
  return { id: nextId++, name, files, handle, docs, truncated: files.size >= MAX_FILES }
}

/** Folders first, then files, case-insensitively. */
export function comparePaths(a: string, b: string) {
  const pa = a.split('/'), pb = b.split('/')
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue
    const aDir = i < pa.length - 1, bDir = i < pb.length - 1
    if (aDir !== bDir) return aDir ? -1 : 1
    return pa[i].localeCompare(pb[i], undefined, { numeric: true, sensitivity: 'base' })
  }
  return pa.length - pb.length
}

/* ---------- File System Access API (Chrome, Edge) ---------- */

export const canPickDirectory = typeof window !== 'undefined' && 'showDirectoryPicker' in window

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (window as any).showDirectoryPicker({ id: 'kmv-folder', mode: 'read' })
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return null
    throw e
  }
}

/** Asks for read access again (needed for folders remembered from an earlier visit). Must run in a click. */
export async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as any
  try {
    if ((await h.queryPermission?.({ mode: 'read' })) === 'granted') return true
    return (await h.requestPermission?.({ mode: 'read' })) === 'granted'
  } catch { return false }
}

export async function fromDirectoryHandle(root: FileSystemDirectoryHandle): Promise<Workspace> {
  const files = new Map<string, WsFile>()
  async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
    for await (const entry of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
      if (files.size >= MAX_FILES) return
      if (entry.kind === 'directory') {
        if (!skipDir(entry.name)) await walk(entry as FileSystemDirectoryHandle, prefix + entry.name + '/')
      } else if (!entry.name.startsWith('.')) {
        const fh = entry as FileSystemFileHandle
        const path = prefix + entry.name
        files.set(path, { path, name: entry.name, kind: kindOf(entry.name), get: () => fh.getFile() })
      }
    }
  }
  await walk(root, '')
  return finish(root.name, files, root)
}

/* ---------- <input webkitdirectory> (Firefox, Safari) ---------- */

export function fromFileList(list: FileList | File[]): Workspace | null {
  const arr = Array.from(list)
  if (!arr.length) return null
  const first = (arr[0] as any).webkitRelativePath as string
  const root = first ? first.split('/')[0] : 'Files'
  const files = new Map<string, WsFile>()
  for (const f of arr) {
    const rel = ((f as any).webkitRelativePath as string) || f.name
    const path = first ? rel.split('/').slice(1).join('/') : rel
    const parts = path.split('/')
    if (parts.slice(0, -1).some(skipDir) || parts[parts.length - 1].startsWith('.')) continue
    if (files.size >= MAX_FILES) break
    files.set(path, { path, name: f.name, kind: kindOf(f.name), get: async () => f })
  }
  return finish(root, files)
}

/* ---------- any list of paths (used for .zip archives) ---------- */

export function workspaceFromEntries(name: string, entries: { path: string; get: () => Promise<File> }[]): Workspace {
  const files = new Map<string, WsFile>()
  for (const e of entries) {
    const parts = e.path.split('/')
    const file = parts[parts.length - 1]
    if (!file || parts.slice(0, -1).some(skipDir) || file.startsWith('.')) continue
    if (files.size >= MAX_FILES) break
    files.set(e.path, { path: e.path, name: file, kind: kindOf(file), get: e.get })
  }
  return finish(name, files)
}

/* ---------- drag and drop of a folder ---------- */

export async function fromDroppedEntry(rootEntry: FileSystemDirectoryEntry): Promise<Workspace> {
  const files = new Map<string, WsFile>()
  const readAll = (dir: FileSystemDirectoryEntry) =>
    new Promise<FileSystemEntry[]>((res, rej) => {
      const reader = dir.createReader()
      const out: FileSystemEntry[] = []
      const next = () => reader.readEntries((batch) => { if (!batch.length) res(out); else { out.push(...batch); next() } }, rej)
      next()
    })
  async function walk(dir: FileSystemDirectoryEntry, prefix: string) {
    for (const e of await readAll(dir)) {
      if (files.size >= MAX_FILES) return
      if (e.isDirectory) { if (!skipDir(e.name)) await walk(e as FileSystemDirectoryEntry, prefix + e.name + '/') }
      else if (!e.name.startsWith('.')) {
        const fe = e as FileSystemFileEntry
        const path = prefix + e.name
        files.set(path, { path, name: e.name, kind: kindOf(e.name), get: () => new Promise<File>((res, rej) => fe.file(res, rej)) })
      }
    }
  }
  await walk(rootEntry, '')
  return finish(rootEntry.name, files)
}

/* ---------- paths ---------- */

export function dirOf(path: string) {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i + 1)
}

/** Resolve a link found in `fromPath` to a path inside the folder. Returns null for links that leave the folder. */
export function resolvePath(fromPath: string, href: string): string | null {
  let p = href.split(/[?#]/)[0]
  try { p = decodeURIComponent(p) } catch { /* keep as written */ }
  p = p.replace(/\\/g, '/')
  const parts = (p.startsWith('/') ? p.slice(1) : dirOf(fromPath) + p).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') { if (!out.length) return null; out.pop() } else out.push(part)
  }
  return out.join('/') + (p.endsWith('/') && out.length ? '/' : '')
}

/** Find the file a link points at, trying the usual Markdown conventions (no extension, folder index). */
export function findFile(ws: Workspace, path: string): WsFile | null {
  const lower = new Map<string, WsFile>()
  const get = (p: string) => {
    const hit = ws.files.get(p)
    if (hit) return hit
    if (!lower.size) for (const [k, v] of ws.files) lower.set(k.toLowerCase(), v)
    return lower.get(p.toLowerCase()) ?? null
  }
  const base = path.replace(/\/$/, '')
  const dir = base ? base + '/' : ''
  if (!path.endsWith('/')) {
    const f = get(base) ?? get(base + '.md') ?? get(base + '.markdown')
    if (f) return f
  }
  return get(dir + 'index.md') ?? get(dir + 'README.md') ?? get(dir + 'readme.md')
}

/**
 * Resolve a link to a file in the folder. OKF bundles of v0.2 or earlier may also resolve
 * paths from the bundle root, so `rootFallback` tries that when the relative path misses.
 */
export function resolveLink(ws: Workspace, fromPath: string, href: string, rootFallback = false): { target: string | null; file: WsFile | null } {
  const target = resolvePath(fromPath, href)
  const file = target !== null ? findFile(ws, target) : null
  if (!file && rootFallback && !href.startsWith('/') && dirOf(fromPath)) {
    const alt = resolvePath('', href)
    const f2 = alt !== null ? findFile(ws, alt) : null
    if (f2) return { target: alt, file: f2 }
  }
  return { target, file }
}

/** The file to show first when a folder opens. */
export function startFile(ws: Workspace): string | null {
  return findFile(ws, '')?.path ?? ws.docs.find((d) => !d.includes('/')) ?? ws.docs[0] ?? null
}

/* ---------- blob: URLs for images ---------- */

const urlCache = new WeakMap<Workspace, Map<string, Promise<string>>>()
export function assetUrl(ws: Workspace, file: WsFile): Promise<string> {
  let m = urlCache.get(ws)
  if (!m) urlCache.set(ws, (m = new Map()))
  if (!m.has(file.path)) m.set(file.path, file.get().then((f) => URL.createObjectURL(f)))
  return m.get(file.path)!
}
export function releaseWorkspace(ws: Workspace) {
  const m = urlCache.get(ws)
  m?.forEach((p) => p.then((u) => URL.revokeObjectURL(u)).catch(() => {}))
  urlCache.delete(ws)
}
