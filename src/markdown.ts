import { unified, type Processor } from 'unified'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeKatex from 'rehype-katex'
import rehypeStringify from 'rehype-stringify'
import rehypeShikiFromHighlighter from '@shikijs/rehype/core'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { visit } from 'unist-util-visit'
import type { Root, Element } from 'hast'

/* ---------- Rendering ---------- */

const ALERTS = ['note', 'tip', 'important', 'warning', 'caution']

const schema: SanitizeSchema = {
  ...defaultSchema,
  // Images pasted into a file that has no folder to save them in are embedded as data: URLs.
  protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), 'data'] },
  attributes: {
    ...defaultSchema.attributes,
    // data-line: the source line of each top-level block, for keeping the editor and preview in step
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'dataLine'],
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', 'math', 'math-display', 'markdown-alert', ...ALERTS.map((a) => 'markdown-alert-' + a)]],
    p: [...(defaultSchema.attributes?.p ?? []), ['className', 'markdown-alert-title']],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', 'math', 'math-inline']],
  },
}

/** GitHub alerts: a quote starting with [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION]. */
function remarkAlerts() {
  return (tree: any) => {
    visit(tree, 'blockquote', (node: any) => {
      const p = node.children?.[0]
      const t = p?.type === 'paragraph' ? p.children?.[0] : null
      if (t?.type !== 'text') return
      const m = /^\[!(note|tip|important|warning|caution)\][ \t]*(\n|$)/i.exec(t.value)
      if (!m) return
      const kind = m[1].toLowerCase()
      t.value = t.value.slice(m[0].length)
      if (!t.value) p.children.shift()
      if (p.children[0]?.type === 'break') p.children.shift()
      if (!p.children.length) node.children.shift()
      node.data = { ...node.data, hName: 'div', hProperties: { className: ['markdown-alert', 'markdown-alert-' + kind] } }
      node.children.unshift({
        type: 'paragraph',
        data: { hProperties: { className: ['markdown-alert-title'] } },
        children: [{ type: 'text', value: kind[0].toUpperCase() + kind.slice(1) }],
      })
    })
  }
}

/** Mark each top-level block with the line it starts on. */
function remarkSourceLines() {
  return (tree: any) => {
    for (const n of tree.children ?? []) {
      const line = n.position?.start?.line
      if (!line || n.type === 'yaml' || n.type === 'html' || n.type === 'definition' || n.type === 'footnoteDefinition') continue
      n.data = { ...n.data, hProperties: { ...n.data?.hProperties, dataLine: line } }
    }
  }
}

/** Turn ```mermaid blocks into placeholders before Shiki sees them. */
function rehypeMermaid() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element, index, parent) => {
      if (node.tagName !== 'pre' || !parent || index === undefined) return
      const code = node.children[0] as Element | undefined
      const cls = (code?.properties?.className as string[] | undefined) ?? []
      if (code?.tagName !== 'code' || !cls.includes('language-mermaid')) return
      const text = (code.children as { value?: string }[]).map((c) => c.value ?? '').join('')
      parent.children[index] = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['mermaid-block'], dataSource: text },
        children: [{ type: 'element', tagName: 'pre', properties: { className: ['mermaid-fallback'] }, children: [{ type: 'text', value: text }] }],
      }
    })
  }
}

/** Whether a URL points at a file next to the document (not a web address, data or an in-page anchor). */
export function isLocalUrl(url: string) {
  return !!url && !url.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//')
}

/**
 * Images with relative paths can only be shown from an opened folder, so their path is moved
 * to data-local-src. The app fills in a blob: URL, and the browser never asks the server for them.
 */
function rehypeLocalImages() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'img') return
      const src = String(node.properties?.src ?? '')
      if (!isLocalUrl(src)) return
      const { src: _drop, ...rest } = node.properties ?? {}
      node.properties = { ...rest, dataLocalSrc: src, className: ['local-img'] }
    })
  }
}

/** Open external links in a new tab safely. */
function rehypeExternalLinks() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      const href = node.tagName === 'a' ? String(node.properties?.href ?? '') : ''
      if (/^https?:\/\//i.test(href)) {
        node.properties = { ...node.properties, target: '_blank', rel: ['noopener', 'noreferrer'] }
      }
    })
  }
}

export const LANGS = [
  'javascript', 'typescript', 'jsx', 'tsx', 'json', 'yaml', 'toml', 'bash', 'shellscript', 'python', 'html', 'css',
  'markdown', 'go', 'rust', 'sql', 'java', 'c', 'cpp', 'diff', 'php', 'ruby',
]

let processorPromise: Promise<Processor<any, any, any, any, string>> | null = null

function getProcessor() {
  if (!processorPromise) {
    processorPromise = (async () => {
      const highlighter: HighlighterCore = await createHighlighterCore({
        themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark-dimmed.mjs')],
        langs: [
          import('shiki/langs/javascript.mjs'), import('shiki/langs/typescript.mjs'), import('shiki/langs/jsx.mjs'),
          import('shiki/langs/tsx.mjs'), import('shiki/langs/json.mjs'), import('shiki/langs/yaml.mjs'),
          import('shiki/langs/toml.mjs'), import('shiki/langs/bash.mjs'), import('shiki/langs/python.mjs'),
          import('shiki/langs/html.mjs'), import('shiki/langs/css.mjs'), import('shiki/langs/markdown.mjs'),
          import('shiki/langs/go.mjs'), import('shiki/langs/rust.mjs'), import('shiki/langs/sql.mjs'),
          import('shiki/langs/java.mjs'), import('shiki/langs/c.mjs'), import('shiki/langs/cpp.mjs'),
          import('shiki/langs/diff.mjs'), import('shiki/langs/php.mjs'), import('shiki/langs/ruby.mjs'),
        ],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      })
      highlighterRef = highlighter
      return unified()
        .use(remarkParse)
        .use(remarkFrontmatter, ['yaml'])
        .use(remarkGfm)
        .use(remarkMath)
        .use(remarkAlerts)
        .use(remarkSourceLines)
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(rehypeRaw)
        .use(rehypeSanitize, schema)
        .use(rehypeMermaid)
        .use(rehypeLocalImages)
        .use(rehypeSlug)
        .use(rehypeAutolinkHeadings, {
          behavior: 'append',
          properties: { className: ['anchor'], ariaLabel: 'Link to this section' },
          content: { type: 'text', value: '#' },
        })
        .use(rehypeExternalLinks)
        .use(rehypeKatex, { throwOnError: false, strict: false })
        .use(rehypeShikiFromHighlighter, highlighter, {
          themes: { light: 'github-light', dark: 'github-dark-dimmed' },
          defaultColor: false,
          fallbackLanguage: 'text',
          addLanguageClass: true,
        })
        .use(rehypeStringify) as unknown as Processor<any, any, any, any, string>
    })()
  }
  return processorPromise
}

let highlighterRef: HighlighterCore | null = null

export async function renderMarkdown(src: string): Promise<string> {
  const p = await getProcessor()
  return String(await p.process(src))
}

/** Highlight the raw source for the "Source" view. */
export async function highlightSource(src: string): Promise<string> {
  await getProcessor()
  return highlighterRef!.codeToHtml(src, {
    lang: 'markdown',
    themes: { light: 'github-light', dark: 'github-dark-dimmed' },
    defaultColor: false,
  })
}
