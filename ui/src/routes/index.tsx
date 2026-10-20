import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { DecisionCard, localTime } from '../parts'

const root = getRouteApi('__root__')

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const { decisions, triggers, stats } = root.useLoaderData()
  const finished = stats.tasks.succeeded
  return (
    <div className="page">
      <h1 className="title">
        {decisions.length === 0 ? 'Nothing to decide' : `${decisions.length} waiting for you`}
      </h1>
      <p className="subtitle">
        {stats.tasks.running} running · {stats.tasks.queued} queued · {finished} succeeded
      </p>

      {decisions.map((d) => (
        <div key={d.id} className="card">
          <div className="card-head">
            <Link to="/tasks/$id" params={{ id: String(d.taskId) }}>
              #{d.taskId}
            </Link>
            {d.issue !== null && <span className="tag">{d.issue}</span>}
            <span className="muted clamp">{d.brief}</span>
          </div>
          <DecisionCard d={d} />
        </div>
      ))}

      <div className="stats">
        <Stat label="Hands-off" value={`${stats.succeededWithoutDecision}/${finished}`}>
          succeeded without a decision
        </Stat>
        <Stat
          label="Decision wait"
          value={
            stats.decisions.medianWaitSecs === null
              ? '-'
              : `${Math.round(stats.decisions.medianWaitSecs)}s`
          }
        >
          median, {stats.decisions.total} decisions
        </Stat>
        <Stat label="Turns" value={String(stats.attempts)}>
          {stats.retries} retries
        </Stat>
        <Stat label="Problems" value={String(stats.tasks.error + stats.tasks.cancelled)}>
          {stats.tasks.error} error · {stats.tasks.cancelled} cancelled
        </Stat>
      </div>

      <h2 className="section">Triggers</h2>
      {triggers.length === 0 ? (
        <p className="muted">
          No triggers. <code>nod trigger add '&lt;cron&gt;' '&lt;brief&gt;'</code> adds work on a
          schedule.
        </p>
      ) : (
        triggers.map((t) => (
          <div key={t.id} className="card">
            <div className="card-head">
              <span className="tag">#{t.id}</span>
              <code>{t.cron}</code>
              <span className="muted">
                {t.lastRunAt === null ? 'not run yet' : `last run ${localTime(t.lastRunAt)}`}
              </span>
            </div>
            <div className="prose">{t.brief}</div>
            {t.source !== null && (
              <div className="hint">
                source <code>{t.source}</code>
              </div>
            )}
            {t.lastError !== null && <div className="banner">{t.lastError}</div>}
          </div>
        ))
      )}
    </div>
  )
}

function Stat({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">{children}</div>
    </div>
  )
}
