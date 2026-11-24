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
import { parseDocument } from 'yaml'
import type { Root, Element } from 'hast'

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

/* ---------- Rendering ---------- */

const schema: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', 'math', 'math-display']],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', 'math', 'math-inline']],
  },
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
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(rehypeRaw)
        .use(rehypeSanitize, schema)
        .use(rehypeMermaid)
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

export function docStats(src: string) {
  const body = src.replace(FM_RE, '').replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`~\-|[\]()!]/g, ' ')
  const words = body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  return { words, minutes: Math.max(1, Math.round(words / 220)) }
}
