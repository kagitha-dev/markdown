/* An opened folder: every file in it, by path relative to the folder ("docs/intro.md"). */

export interface WsFile {
  path: string
  name: string
  kind: 'md' | 'image' | 'other'
  get(): Promise<File>
  /** Present for folders opened with the File System Access API, so the file can be saved back. */
  handle?: FileSystemFileHandle
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
  /** Every folder inside (with a trailing slash), for folders opened with the File System Access API. */
  dirs?: string[]
  /** Folders with nothing in them, so they still show in the tree. */
  emptyDirs?: string[]
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

/** `startIn`: a file or folder the picker should open at (for example the open file, to pick its folder). */
export async function pickDirectory(startIn?: FileSystemHandle): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (window as any).showDirectoryPicker({ id: 'kmv-folder', mode: 'read', ...(startIn ? { startIn } : {}) })
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

/* ---------- saving (File System Access API) ---------- */

export const canSaveFiles = typeof window !== 'undefined' && 'showSaveFilePicker' in window
export const canPickFile = typeof window !== 'undefined' && 'showOpenFilePicker' in window

/** Asks to save into a file or folder. Must run in a click or key press. */
export async function ensureWrite(handle: FileSystemHandle): Promise<boolean> {
  const h = handle as any
  try {
    if ((await h.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true
    return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted'
  } catch { return false }
}

export async function writeFile(handle: FileSystemFileHandle, text: string) {
  const w = await (handle as any).createWritable()
  await w.write(text)
  await w.close()
}

const MD_TYPES = [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mdx', '.txt'] } }]

export async function pickSaveFile(suggestedName: string, startIn?: FileSystemHandle): Promise<FileSystemFileHandle | null> {
  try {
    return await (window as any).showSaveFilePicker({ suggestedName, types: MD_TYPES, id: 'kmv-save', ...(startIn ? { startIn } : {}) })
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return null
    throw e
  }
}

export async function pickOpenFile(): Promise<FileSystemFileHandle | null> {
  try {
    const [h] = await (window as any).showOpenFilePicker({
      id: 'kmv-open',
      types: [
        { description: 'Markdown or text', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mdx'], 'text/plain': ['.txt'] } },
        { description: 'Zip bundle', accept: { 'application/zip': ['.zip'] } },
      ],
    })
    return h ?? null
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return null
    throw e
  }
}

/* ---------- changing files in an opened folder ---------- */

const baseOf = (path: string) => path.replace(/\/$/, '').split('/').pop()!

/** The folder at `dirPath` ("docs/notes/" or ""), created if asked. */
export async function dirAt(root: FileSystemDirectoryHandle, dirPath: string, create = false): Promise<FileSystemDirectoryHandle> {
  let dir = root
  for (const p of dirPath.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(p, { create })
  return dir
}

export async function existsAt(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  const isDir = path.endsWith('/')
  try {
    const parent = await dirAt(root, dirOf(path.replace(/\/$/, '')))
    if (isDir) await parent.getDirectoryHandle(baseOf(path))
    else await parent.getFileHandle(baseOf(path))
    return true
  } catch { return false }
}

/** Write a file (and any folders on its path) inside an opened folder. */
export async function writeAt(root: FileSystemDirectoryHandle, path: string, data: string | Blob): Promise<FileSystemFileHandle> {
  const dir = await dirAt(root, dirOf(path), true)
  const h = await dir.getFileHandle(baseOf(path), { create: true })
  const w = await (h as any).createWritable()
  await w.write(data)
  await w.close()
  return h
}
export const createFileIn = writeAt

export async function createFolder(root: FileSystemDirectoryHandle, path: string) {
  await dirAt(root, path, true)
}

/** Delete a file, or a folder with everything in it. This can't be undone. */
export async function removeAt(root: FileSystemDirectoryHandle, path: string) {
  const parent = await dirAt(root, dirOf(path.replace(/\/$/, '')))
  await parent.removeEntry(baseOf(path), { recursive: path.endsWith('/') })
}

async function copyDir(src: FileSystemDirectoryHandle, dst: FileSystemDirectoryHandle) {
  for await (const entry of (src as any).values() as AsyncIterable<FileSystemHandle>) {
    if (entry.kind === 'directory') await copyDir(entry as FileSystemDirectoryHandle, await dst.getDirectoryHandle(entry.name, { create: true }))
    else {
      const out = await dst.getFileHandle(entry.name, { create: true })
      const w = await (out as any).createWritable()
      await w.write(await (entry as FileSystemFileHandle).getFile())
      await w.close()
    }
  }
}

/**
 * Rename or move a file or folder ("a/b.md" → "c/d.md", "a/" → "c/a/").
 * Uses the browser's move() where it works; otherwise copies everything (hidden files too) and deletes the original.
 */
export async function moveAt(root: FileSystemDirectoryHandle, from: string, to: string) {
  const isDir = from.endsWith('/')
  const parent = await dirAt(root, dirOf(from.replace(/\/$/, '')))
  const h: any = isDir ? await parent.getDirectoryHandle(baseOf(from)) : await parent.getFileHandle(baseOf(from))
  const target = await dirAt(root, dirOf(to.replace(/\/$/, '')), true)
  if (typeof h.move === 'function') {
    try { await h.move(target, baseOf(to)); return } catch { /* not supported here: copy instead */ }
    if ((await existsAt(root, to)) && !(await existsAt(root, from))) return
  }
  if (isDir) await copyDir(h, await target.getDirectoryHandle(baseOf(to), { create: true }))
  else {
    const out = await target.getFileHandle(baseOf(to), { create: true })
    const w = await (out as any).createWritable()
    await w.write(await h.getFile())
    await w.close()
  }
  await parent.removeEntry(baseOf(from), { recursive: isDir })
}

/** Characters that aren't allowed in file names on Windows, macOS or Linux. */
export const badName = (name: string) => !name || name === '.' || name === '..' || /[<>:"|?*\\/\u0000-\u001f]/.test(name) || /[. ]$/.test(name)

export async function fromDirectoryHandle(root: FileSystemDirectoryHandle): Promise<Workspace> {
  const files = new Map<string, WsFile>()
  const dirs: string[] = []
  const emptyDirs: string[] = []
  async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
    let any = false
    for await (const entry of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
      any = true
      if (files.size >= MAX_FILES) return
      if (entry.kind === 'directory') {
        if (!skipDir(entry.name)) { dirs.push(prefix + entry.name + '/'); await walk(entry as FileSystemDirectoryHandle, prefix + entry.name + '/') }
      } else if (!entry.name.startsWith('.')) {
        const fh = entry as FileSystemFileHandle
        const path = prefix + entry.name
        files.set(path, { path, name: entry.name, kind: kindOf(entry.name), get: () => fh.getFile(), handle: fh })
      }
    }
    if (!any && prefix) emptyDirs.push(prefix)
  }
  await walk(root, '')
  return { ...finish(root.name, files, root), dirs: dirs.sort(comparePaths), emptyDirs }
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
/** The Markdown file in the folder with this name, nearest the top (for reopening a single file inside its folder). */
export function fileNamed(ws: Workspace, name: string): string | null {
  const low = name.toLowerCase()
  return ws.docs.filter((d) => (d.split('/').pop() ?? '').toLowerCase() === low).sort(comparePaths)[0] ?? null
}

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
