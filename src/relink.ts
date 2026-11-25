/*
 * Keeps links working when files or folders are renamed or moved: rewrites links that point at
 * moved files, and relative links inside moved files. Code blocks are left alone.
 * Links are matched in Markdown ([text](url), ![alt](url), [ref]: url), raw HTML (src="", href="")
 * and path-like values in the front matter (superseded_by: other.md, - images/a.png).
 */
import { dirOf, resolveLink, type Workspace } from './workspace'

const isLocal = (u: string) => !!u && !u.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//')
const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

/** A relative link from a file to another file ("a/b.md" → "c/d.md" gives "../c/d.md"); folders end with "/". */
export function relPath(fromFile: string, to: string): string {
  const from = dirOf(fromFile).split('/').filter(Boolean)
  const isDir = to.endsWith('/')
  const t = to.split('/').filter(Boolean)
  let i = 0
  while (i < from.length && i < t.length - (isDir ? 0 : 1) && from[i] === t[i]) i++
  const rest = t.slice(i).join('/') + (isDir && t.length > i ? '/' : '')
  return '../'.repeat(from.length - i) + rest || './'
}

/** Percent-encode the characters that would break a Markdown link. */
const encodeLink = (p: string) => p.split('/').map((seg) => seg.replace(/[ ()<>%]/g, (c) => encodeURIComponent(c))).join('/')

export interface Relinker {
  /** The new text of the file at `oldSelf` (moving to `newSelf`), and how many links changed. */
  rewrite(text: string, oldSelf: string, newSelf: string): { text: string; count: number }
}

/** `moves` maps old paths to new paths for every file that moves. */
export function relinker(ws: Workspace, moves: Map<string, string>, rootFallback: boolean): Relinker {
  const fix = (url: string, oldSelf: string, newSelf: string): string | null => {
    let raw = url
    let angle = false
    if (raw.startsWith('<') && raw.endsWith('>')) { raw = raw.slice(1, -1); angle = true }
    if (!isLocal(raw)) return null
    const cut = raw.search(/[?#]/)
    const pathPart = cut < 0 ? raw : raw.slice(0, cut)
    const tail = cut < 0 ? '' : raw.slice(cut)
    if (!pathPart) return null
    const { file } = resolveLink(ws, oldSelf, pathPart, rootFallback)
    if (!file) return null
    const oldT = file.path
    const newT = moves.get(oldT) ?? oldT
    if (newT === oldT && dirOf(newSelf) === dirOf(oldSelf)) return null
    const written = decode(pathPart).replace(/\\/g, '/')
    const name = file.name.toLowerCase()
    const stem = name.replace(/\.(md|markdown)$/, '')
    const last = written.replace(/\/$/, '').split('/').pop()!.toLowerCase()
    let target = newT
    let dropExt = false
    if (last !== name && last === stem) dropExt = true // written without ".md"
    else if (last !== name) target = dirOf(newT) // a folder link that opened its index.md / README.md
    let out = written.startsWith('/') ? '/' + target : relPath(newSelf, target)
    if (dropExt) out = out.replace(/\.(md|markdown)$/i, '')
    if (decode(out) === written) return null
    return angle ? `<${out}${tail}>` : encodeLink(out) + tail
  }

  return {
    rewrite(text, oldSelf, newSelf) {
      let count = 0
      const swap = (url: string) => {
        const next = fix(url, oldSelf, newSelf)
        if (next === null) return url
        count++
        return next
      }
      const lines = text.split('\n')
      let fence = ''
      let inFm = lines[0]?.trim() === '---'
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i]
        if (inFm) {
          if (i > 0 && /^(---|\.\.\.)\s*$/.test(line)) { inFm = false; continue }
          // key: path.md   or   - path.md   (quoted or not)
          const m = /^(\s*(?:-\s+|[\w.-]+:\s+))(["']?)([^"'\s#][^"'#\n]*?)\2(\s*)$/.exec(line)
          if (m && /\.[a-z0-9]{2,5}$/i.test(m[3]) && !/^[a-z][a-z0-9+.-]*:/i.test(m[3])) {
            const next = fix(m[3], oldSelf, newSelf)
            if (next !== null) { count++; lines[i] = m[1] + m[2] + decode(next) + m[2] + m[4] }
          }
          continue
        }
        const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
        if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = ''; continue }
        if (fence) continue
        // [text](url "title"), ![alt](url), skipping `inline code`
        line = line.replace(/(`+)[^`]*\1|(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s]+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\))/g,
          (all, code, open, url, close) => (code ? all : open + swap(url) + close))
        // [ref]: url
        line = line.replace(/^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>\n]+>|\S+)/, (_, open, url) => open + swap(url))
        // <img src="…"> <a href="…">
        line = line.replace(/(\b(?:src|href)\s*=\s*")([^"\n]+)(")/gi, (_, open, url, close) => open + swap(url) + close)
        lines[i] = line
      }
      return { text: count ? lines.join('\n') : text, count }
    },
  }
}
