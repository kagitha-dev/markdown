import { useState } from 'react'
import type { FmValue, Frontmatter } from './frontmatter'
import { okfSignals, relDate, TIER_LABEL } from './okf-core'

const OKF_HINT = 'OKF uses `type` as its one required field'

function Value({ v }: { v: FmValue }) {
  if (v === null) return <span className="fm-null">empty</span>
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="fm-null">none</span>
    if (v.every((x) => x === null || typeof x !== 'object'))
      return (
        <span className="fm-chips">
          {v.map((x, i) => (
            <span key={i} className={'fm-chip' + (typeof x === 'string' && /\.md$/i.test(x) ? ' fm-chip--file' : '')}>
              {String(x)}
            </span>
          ))}
        </span>
      )
    return (
      <ol className="fm-list">
        {v.map((x, i) => (
          <li key={i}><Value v={x} /></li>
        ))}
      </ol>
    )
  }
  if (typeof v === 'object') {
    return (
      <dl className="fm-nested">
        {Object.entries(v).map(([k, x]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd><Value v={x} /></dd>
          </div>
        ))}
      </dl>
    )
  }
  if (typeof v === 'boolean') return <span className={'fm-bool fm-bool--' + v}>{v ? 'true' : 'false'}</span>
  if (typeof v === 'number') return <span className="fm-num">{v}</span>
  if (/^https?:\/\/\S+$/i.test(v))
    return (
      <a href={v} target="_blank" rel="noopener noreferrer" className="fm-link">
        {v.replace(/^https?:\/\//, '')}
      </a>
    )
  return <span>{v}</span>
}

/** Status, trust tier and freshness, derived the way the OKF spec defines them. */
function OkfSignals({ data }: { data: Record<string, FmValue> }) {
  const s = okfSignals(data)
  const hasTrust = 'verified' in data || 'generated' in data
  const rows: [string, React.ReactNode, string?][] = []
  if (s.status || s.badStatus) rows.push(['Status', s.badStatus ? `${s.badStatus} (not a defined status)` : s.status, s.status === 'deprecated' ? 'warn' : s.status === 'draft' ? 'muted' : 'ok'])
  if (hasTrust || s.tier !== 'unverified')
    rows.push(['Trust', <>{TIER_LABEL[s.tier]}{s.lastVerified ? <span className="sig-sub">verified {relDate(s.lastVerified)}</span> : null}</>, s.tier === 'human' ? 'ok' : s.tier === 'outdated' ? 'warn' : 'muted'])
  if (s.staleAfter) rows.push([s.stale ? 'Stale' : 'Fresh until', s.stale ? <>since {relDate(s.staleAfter)}</> : relDate(s.staleAfter), s.stale ? 'warn' : 'ok'])
  if (s.supersededBy) rows.push(['Replaced by', <code>{s.supersededBy}</code>, 'warn'])
  if (!rows.length) return null
  return (
    <dl className="signals">
      {rows.map(([k, v, tone]) => (
        <div key={k} className={'sig sig--' + (tone ?? 'muted')}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function FrontmatterCard({ fm }: { fm: Frontmatter | null }) {
  const [raw, setRaw] = useState(false)

  if (!fm)
    return (
      <section className="panel" aria-labelledby="fm-h">
        <h2 id="fm-h" className="panel-h">Frontmatter</h2>
        <p className="panel-empty">
          This file has no YAML frontmatter. Add a block between <code>---</code> lines at the very top to describe it.
        </p>
      </section>
    )

  if (fm.error)
    return (
      <section className="panel panel--error" aria-labelledby="fm-h" role="alert">
        <h2 id="fm-h" className="panel-h">Frontmatter has an error</h2>
        <p className="fm-error">
          {fm.error.line ? <strong>Line {fm.error.line}: </strong> : null}
          {fm.error.message}
        </p>
        <pre className="fm-raw">
          {fm.raw.split('\n').map((l, i) => (
            <span key={i} className={'fm-raw-line' + (fm.error!.line === i + 2 ? ' is-bad' : '')}>
              <span className="fm-ln">{i + 2}</span>
              {l || ' '}
            </span>
          ))}
        </pre>
      </section>
    )

  const entries = Object.entries(fm.data ?? {})
  const type = fm.data?.type
  const rest = entries.filter(([k]) => k !== 'type')

  return (
    <section className="panel" aria-labelledby="fm-h">
      <div className="panel-top">
        <h2 id="fm-h" className="panel-h">
          Frontmatter <span className="panel-count">{entries.length} {entries.length === 1 ? 'field' : 'fields'}</span>
        </h2>
        <button type="button" className="link-btn" onClick={() => setRaw((r) => !r)} aria-pressed={raw}>
          {raw ? 'Card' : 'YAML'}
        </button>
      </div>

      {raw ? (
        <pre className="fm-raw">
          {fm.raw.split('\n').map((l, i) => (
            <span key={i} className="fm-raw-line">
              <span className="fm-ln">{i + 2}</span>
              {l || ' '}
            </span>
          ))}
        </pre>
      ) : (
        <>
          {typeof type === 'string' && type.trim() ? (
            <>
              <div className="okf" title={OKF_HINT}>
                <span className="okf-label">OKF type</span>
                <span className="okf-value">{type}</span>
              </div>
              <OkfSignals data={fm.data!} />
            </>
          ) : null}
          {entries.length === 0 ? (
            <p className="panel-empty">The frontmatter block is empty.</p>
          ) : (
            <dl className="fm">
              {rest.map(([k, v]) => (
                <div key={k} className="fm-row">
                  <dt>{k}</dt>
                  <dd><Value v={v} /></dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </section>
  )
}
