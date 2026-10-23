import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import type { TaskRow } from '../nod.server'
import { DecisionCard, localTime, Status, TaskId } from '../parts'
import { Section } from '../todo-parts'

const root = getRouteApi('__root__')

export const Route = createFileRoute('/')({ component: Home })

// The decisions waiting for the person, the tasks not yet collected by project, how hands-off nod
// has been, and the triggers that add work on a schedule.
function Home() {
  const { decisions, groups, triggers, stats } = root.useLoaderData()
  const finished = stats.tasks.succeeded
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
                  <TaskId id={d.taskId} todoId={d.todoId} retroId={d.retroId} />
                  {d.issue !== null && <span className="tag">{d.issue}</span>}
                  <span className="clamp">{d.brief.split('\n')[0]}</span>
                  <span className="go">Answer →</span>
                </Link>
              }
            />
          ))}
        </Section>
      )}

      {groups.length === 0 ? (
        <Section title="Tasks" count={0} bare>
          <p className="muted">No tasks. Hand work over with nod add.</p>
        </Section>
      ) : (
        groups.map((g) => (
          <ProjectGroup
            key={g.project?.id ?? 0}
            fold={`project:${g.project?.id ?? 'none'}`}
            title={g.project?.title ?? 'No project'}
            count={g.tasks.length}
          >
            {g.tasks.map((t) => (
              <TaskLine key={t.id} t={t} />
            ))}
          </ProjectGroup>
        ))
      )}

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

// A project's tasks under its title, which folds them away. What is folded is kept in this
// browser, so a project stays folded across pages and visits.
function ProjectGroup({
  fold,
  title,
  count,
  children,
}: {
  fold: string
  title: string
  count: number
  children: ReactNode
}) {
  const [folded, setFolded] = useFolded(fold)
  return (
    <details className="fold" open={!folded} onToggle={(e) => setFolded(!e.currentTarget.open)}>
      <summary className="section">
        {title}
        <span className="count">{count}</span>
      </summary>
      <div className="list">{children}</div>
    </details>
  )
}

const FOLDED = 'nod.folded'

// ponytail: storage can be missing or refused (a private window), and folding is only a
// convenience, so it then lasts until the page is left.
function readFolded(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FOLDED) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

// Open on the server's first render, then as this browser left it.
function useFolded(key: string): [boolean, (folded: boolean) => void] {
  const [folded, setFolded] = useState(false)
  useEffect(() => setFolded(readFolded().includes(key)), [key])
  const set = (v: boolean) => {
    setFolded(v)
    const rest = readFolded().filter((k) => k !== key)
    try {
      localStorage.setItem(FOLDED, JSON.stringify(v ? [...rest, key] : rest))
    } catch {
      // ponytail: see readFolded
    }
  }
  return [folded, set]
}

// A task: what it is, then how it went last, with its status spelled out.
function TaskLine({ t }: { t: TaskRow }) {
  return (
    <Link to="/tasks/$id" params={{ id: String(t.id) }} className="task-line">
      <TaskId id={t.id} todoId={t.todoId} retroId={t.retroId} />
      <div className="task-line-main">
        <div className="clamp">{t.title}</div>
        <div className="task-line-sub">
          {t.issue !== null && <span className="tag">{t.issue}</span>}
          {!t.note.startsWith(t.title) && <span className="clamp">{t.note}</span>}
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
