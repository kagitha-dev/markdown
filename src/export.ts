import type { FmValue } from './frontmatter'

/* ---------- helpers ---------- */

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** A safe file name (without extension) from a document title or file name. */
export function baseName(title: string, fileName: string) {
  const fromFile = fileName.replace(/\.[^.]+$/, '')
  const src = fromFile && fromFile !== 'pasted' && fromFile !== 'welcome' ? fromFile : title || fromFile
  const clean = src.normalize('NFKD').replace(/[^\p{L}\p{N}._ -]+/gu, '').trim().replace(/\s+/g, '-')
  return clean.slice(0, 80) || 'document'
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/* ---------- frontmatter as a metadata block ---------- */

function valueHtml(v: FmValue): string {
  if (v === null) return '<span class="dm-empty">empty</span>'
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object'))
      return v.map((x) => `<span class="dm-chip">${escapeHtml(String(x))}</span>`).join(' ')
    return `<ol>${v.map((x) => `<li>${valueHtml(x)}</li>`).join('')}</ol>`
  }
  if (typeof v === 'object')
    return `<dl class="dm-nested">${Object.entries(v)
      .map(([k, x]) => `<div><dt>${escapeHtml(k)}</dt><dd>${valueHtml(x)}</dd></div>`)
      .join('')}</dl>`
  const s = String(v)
  if (/^https?:\/\/\S+$/i.test(s)) return `<a href="${escapeHtml(s)}">${escapeHtml(s)}</a>`
  return escapeHtml(s)
}

/** Frontmatter rendered as a compact table for print and HTML export. Values are escaped. */
export function metaHtml(data: Record<string, FmValue> | null | undefined): string {
  if (!data) return ''
  const rows = Object.entries(data)
  if (!rows.length) return ''
  return `<aside class="doc-meta" aria-label="Document details"><dl>${rows
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${valueHtml(v)}</dd></div>`)
    .join('')}</dl></aside>`
}

/* ---------- article clean-up ---------- */

/** A copy of the rendered article without the app's interactive bits. */
export function cleanArticle(article: HTMLElement): HTMLElement {
  const copy = article.cloneNode(true) as HTMLElement
  copy.querySelectorAll('.code-copy').forEach((b) => b.remove())
  copy.querySelectorAll('.code-bar').forEach((b) => { if (!b.textContent?.trim()) b.remove() })
  copy.querySelectorAll('[data-error]').forEach((b) => b.removeAttribute('data-error'))
  copy.querySelectorAll('[data-line]').forEach((b) => b.removeAttribute('data-line'))
  // Long pages are grouped into chunks on screen; exports don't need them.
  copy.querySelectorAll('.cv-chunk').forEach((c) => c.replaceWith(...Array.from(c.childNodes)))
  return copy
}

/* ---------- images from an opened folder ---------- */

/** Images from a folder are shown with blob: URLs that only live in this tab, so embed them. */
async function inlineImages(root: HTMLElement) {
  await Promise.all(
    Array.from(root.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')).map(async (img) => {
      try { img.src = await toDataUrl(await (await fetch(img.src)).blob()) } catch { /* leave as is */ }
      img.removeAttribute('data-local-src')
    }),
  )
}

/* ---------- styles with fonts inlined ---------- */

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(r.error)
    r.readAsDataURL(blob)
  })
}

const fontCache = new Map<string, Promise<string | null>>()
function inlineFont(url: string): Promise<string | null> {
  if (url.startsWith('data:')) return Promise.resolve(url)
  if (!fontCache.has(url))
    fontCache.set(url, fetch(url).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? toDataUrl(b) : null)).catch(() => null))
  return fontCache.get(url)!
}

/**
 * All of the page's CSS as one string, with web fonts embedded so the exported
 * file looks the same offline. KaTeX fonts are only embedded when the document has math.
 */
export async function collectCss(opts: { math: boolean }): Promise<string> {
  const parts: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try { rules = sheet.cssRules } catch { continue }
    const base = sheet.href || location.href
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSFontFaceRule) {
        const family = rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim()
        if (/^KaTeX_/.test(family) && !opts.math) continue
        const src = rule.style.getPropertyValue('src')
        const m = /url\(\s*["']?([^"')]+?\.woff2[^"')]*)["']?\s*\)/.exec(src) ?? /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(src)
        if (!m) continue
        const data = await inlineFont(new URL(m[1], base).href)
        if (!data) continue
        const fmt = data.startsWith('data:font/woff2') || /\.woff2/.test(m[1]) ? 'woff2' : 'woff'
        const other = Array.from(rule.style)
          .filter((p) => p !== 'src')
          .map((p) => `${p}:${rule.style.getPropertyValue(p)}`)
          .join(';')
        parts.push(`@font-face{${other};src:url(${data}) format("${fmt}")}`)
      } else {
        parts.push(rule.cssText)
      }
    }
  }
  return parts.join('\n')
}

/* ---------- standalone HTML ---------- */

export async function buildStandaloneHtml(opts: {
  article: HTMLElement
  title: string
  description?: string
  meta: string
}): Promise<string> {
  const body = cleanArticle(opts.article)
  await inlineImages(body)
  const css = await collectCss({ math: !!body.querySelector('.katex') })
  const desc = opts.description ? `<meta name="description" content="${escapeHtml(opts.description)}">` : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="kagitha Markdown Viewer (markdown.kagitha.com)">
<title>${escapeHtml(opts.title)}</title>
${desc}
<script>try{if(matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.classList.add('dark')}catch(e){}</script>
<style>${css}</style>
</head>
<body class="export">
<main class="reading">
${opts.meta}
<article class="prose">${body.innerHTML}</article>
</main>
</body>
</html>`
}

/* ---------- rich-text copy ---------- */

/** Copies the article as formatted text (for Google Docs, Word, email) with a plain-text fallback. */
export async function copyRich(article: HTMLElement, meta: string) {
  const body = cleanArticle(article)
  body.querySelectorAll('.anchor, .code-bar, .mermaid-block').forEach((n) => n.remove())
  body.querySelectorAll('.katex-mathml').forEach((n) => n.remove())
  await inlineImages(body)
  const html = `${meta}${body.innerHTML}`
  const text = body.innerText || body.textContent || ''
  if ('ClipboardItem' in window && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ])
  } else {
    await navigator.clipboard.writeText(text)
  }
}
