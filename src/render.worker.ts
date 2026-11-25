/* Turns Markdown into HTML off the main thread, so large files don't freeze the page. */
import { highlightSource, renderMarkdown } from './markdown'

self.onmessage = async (e: MessageEvent<{ id: number; kind: 'preview' | 'source' | 'peek'; text: string }>) => {
  const { id, kind, text } = e.data
  try {
    const html = kind === 'source' ? await highlightSource(text) : await renderMarkdown(text)
    self.postMessage({ id, html })
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message ?? err) })
  }
}
