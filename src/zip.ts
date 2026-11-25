/* Open a .zip (for example an OKF bundle shared as an archive) as a folder. Unpacked in memory only. */
import JSZip from 'jszip'
import { workspaceFromEntries, type Workspace } from './workspace'

export const MAX_ZIP = 200_000_000

export async function fromZip(file: Blob & { name: string }): Promise<Workspace> {
  const zip = await JSZip.loadAsync(file)
  const entries = Object.values(zip.files).filter((e) => !e.dir && !e.name.startsWith('__MACOSX/'))
  // Most archives wrap everything in one top-level folder; drop it so paths start at the bundle root.
  const tops = new Set(entries.map((e) => e.name.split('/')[0]))
  const strip = tops.size === 1 && entries.every((e) => e.name.includes('/')) ? [...tops][0] + '/' : ''
  const name = strip ? strip.slice(0, -1) : file.name.replace(/\.zip$/i, '')
  const ws = workspaceFromEntries(
    name,
    entries.map((e) => ({
      path: e.name.slice(strip.length),
      get: async () => new File([await e.async('blob')], e.name.slice(e.name.lastIndexOf('/') + 1)),
    })),
  )
  ws.source = 'zip'
  return ws
}
