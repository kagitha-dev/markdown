/*
 * Runs the Markdown pipeline in a Web Worker. In the single-file preview build, where workers
 * may be blocked, it falls back to rendering on the page itself.
 * A new request while a large file is still rendering restarts the worker, so switching
 * files never waits for a render nobody needs any more.
 */
/** peek = the first part of a long file, shown while the whole file renders */
type Kind = 'preview' | 'source' | 'peek'
interface Job { id: number; kind: Kind; resolve: (html: string) => void; reject: (e: Error) => void }

let worker: Worker | null = null
let failed = false
let seq = 0
const jobs = new Map<number, Job>()

async function makeWorker(): Promise<Worker> {
  // The single-file preview build can't load a separate worker file, so it inlines one.
  if (import.meta.env.MODE === 'single') {
    const W = (await import('./render.worker?worker&inline')).default
    return new W()
  }
  const W = (await import('./render.worker?worker')).default
  return new W()
}

let starting: Promise<Worker | null> | null = null
function getWorker(): Promise<Worker | null> {
  if (failed || typeof Worker === 'undefined') return Promise.resolve(null)
  if (worker) return Promise.resolve(worker)
  starting ??= makeWorker().then(
    (w) => {
      w.onmessage = (e: MessageEvent<{ id: number; html?: string; error?: string }>) => {
        const job = jobs.get(e.data.id)
        if (!job) return
        jobs.delete(e.data.id)
        if (e.data.error !== undefined) job.reject(new Error(e.data.error))
        else job.resolve(e.data.html ?? '')
      }
      w.onerror = (ev) => {
        // The worker couldn't start or crashed: finish the waiting jobs on the page instead.
        ev.preventDefault?.()
        failed = true
        worker?.terminate()
        worker = null
        const waiting = [...jobs.values()]
        jobs.clear()
        waiting.forEach((j) => onPage(j.kind, pendingText.get(j.id) ?? '').then(j.resolve, j.reject))
      }
      worker = w
      starting = null
      return w
    },
    () => { failed = true; starting = null; return null },
  )
  return starting
}

const pendingText = new Map<number, string>()

async function onPage(kind: Kind, text: string) {
  // The production site always has workers, so only the dev server and the single-file preview
  // (which may run where workers are blocked) carry a second copy of the pipeline for the page itself.
  if (import.meta.env.PROD && import.meta.env.MODE !== 'single') throw new Error('the background renderer could not start. Reload the page to try again.')
  const m = await import('./markdown')
  return kind === 'source' ? m.highlightSource(text) : m.renderMarkdown(text)
}

/**
 * The opening part of a long Markdown file, cut just before a heading (never inside a code block),
 * so it can be shown while the whole file renders.
 */
export function headOf(text: string, minLines = 600, maxLines = 2500): string | null {
  const lines = text.split('\n')
  if (lines.length < 4000) return null
  let fence: string | null = null
  let blank = -1
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i])
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue }
    if (fence || i < minLines) continue
    if (/^#{1,6}\s/.test(lines[i])) return lines.slice(0, i).join('\n')
    if (!lines[i].trim() && blank < 0) blank = i
  }
  return blank > 0 ? lines.slice(0, blank).join('\n') : null
}

/** Render Markdown (preview) or highlight it (source). Older unfinished requests of the same kind are dropped. */
export async function render(kind: Kind, text: string): Promise<string> {
  const w = await getWorker()
  if (!w) return onPage(kind, text)
  // Drop an unfinished request of the same kind; restart the worker if it's busy with a big one.
  for (const j of [...jobs.values()]) {
    if (j.kind !== kind) continue
    jobs.delete(j.id)
    pendingText.delete(j.id)
    j.reject(new DOMException('Superseded', 'AbortError'))
    if ((pendingSize.get(j.id) ?? 0) > 200_000) restart()
  }
  const id = ++seq
  return new Promise<string>((resolve, reject) => {
    jobs.set(id, { id, kind, resolve, reject })
    pendingText.set(id, text)
    pendingSize.set(id, text.length)
    getWorker().then((cur) => {
      if (!cur) { jobs.delete(id); onPage(kind, text).then(resolve, reject); return }
      cur.postMessage({ id, kind, text })
    })
  }).finally(() => { pendingText.delete(id); pendingSize.delete(id) })
}
const pendingSize = new Map<number, number>()

function restart() {
  const keep = [...jobs.values()]
  worker?.terminate()
  worker = null
  // Re-send anything else that was waiting (for example a Source request).
  keep.forEach((j) => {
    const text = pendingText.get(j.id)
    if (text !== undefined) getWorker().then((w) => w ? w.postMessage({ id: j.id, kind: j.kind, text }) : onPage(j.kind, text).then(j.resolve, j.reject))
  })
}
