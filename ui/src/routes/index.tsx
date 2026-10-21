import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { TaskRow } from '../nod.server'
import { DecisionCard, localTime, Status } from '../parts'
import { Section } from '../todo-parts'

const root = getRouteApi('__root__')

export const Route = createFileRoute('/')({ component: Home })

// What needs the person comes first: decisions, then tasks that went wrong, then those at work.
const RANK: Record<string, number> = {
  needs_decision: 0,
  error: 1,
  failed: 1,
  'session ended': 1,
  running: 2,
  queued: 3,
  succeeded: 4,
}

// The decisions waiting for the person, the tasks not yet collected, how hands-off nod has been,
// and the triggers that add work on a schedule.
function Home() {
  const { decisions, groups, triggers, stats } = root.useLoaderData()
  const finished = stats.tasks.succeeded
  const tasks = groups
    .flatMap((g) => g.tasks.map((t) => ({ ...t, issue: g.issue })))
    .sort((a, b) => (RANK[a.status] ?? 5) - (RANK[b.status] ?? 5))
  return (
    <div className="page">
      <h1 className="title">
        {decisions.length === 0 ? 'Nothing to decide' : `${decisions.length} waiting for you`}
      </h1>
      <p className="subtitle">
        {stats.tasks.running} running · {stats.tasks.queued} queued · {finished} succeeded
      </p>

      {decisions.length > 0 && (
        <Section title="Decide" count={decisions.length} bare>
          {decisions.map((d) => (
            <DecisionCard
              key={d.id}
              d={d}
              head={
                <Link to="/tasks/$id" params={{ id: String(d.taskId) }} className="decision-task">
                  <span className="side-id">#{d.taskId}</span>
                  {d.issue !== null && <span className="tag">{d.issue}</span>}
                  <span className="clamp">{d.brief.split('\n')[0]}</span>
                  <span className="go">Answer →</span>
                </Link>
              }
            />
          ))}
        </Section>
      )}

      <Section title="Tasks" count={tasks.length} bare={tasks.length === 0}>
        {tasks.length === 0 ? (
          <p className="muted">No tasks. Hand work over with nod add.</p>
        ) : (
          tasks.map((t) => <TaskLine key={t.id} t={t} />)
        )}
      </Section>

      <Section title="Stats" bare>
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
      </Section>

      <Section title="Triggers" count={triggers.length} bare={triggers.length === 0}>
        {triggers.length === 0 ? (
          <p className="muted">
            No triggers. <code>nod trigger add '&lt;cron&gt;' '&lt;brief&gt;'</code> adds work on a
            schedule.
          </p>
        ) : (
          triggers.map((t) => (
            <div key={t.id} className="task-line">
              <span className="side-id">#{t.id}</span>
              <div className="task-line-main">
                <div className="clamp">{t.brief}</div>
                <div className="todo-tags">
                  <code>{t.cron}</code>
                  <span>
                    {t.lastRunAt === null ? 'not run yet' : `last run ${localTime(t.lastRunAt)}`}
                  </span>
                  {t.source !== null && <code>{t.source}</code>}
                </div>
                {t.lastError !== null && <div className="banner">{t.lastError}</div>}
              </div>
            </div>
          ))
        )}
      </Section>
    </div>
  )
}

// A task on one line, as the sidebar lists it, with its status spelled out.
function TaskLine({ t }: { t: TaskRow & { issue: string | null } }) {
  return (
    <Link to="/tasks/$id" params={{ id: String(t.id) }} className="task-line">
      <span className="side-id">#{t.id}</span>
      <div className="task-line-main">
        <div className="clamp">{t.note}</div>
        <div className="todo-tags">
          {t.issue !== null && <span className="tag">{t.issue}</span>}
          <span>
            {t.turns} {t.turns === 1 ? 'turn' : 'turns'}
          </span>
        </div>
      </div>
      <Status status={t.status} />
    </Link>
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
