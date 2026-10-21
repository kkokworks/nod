import { createFileRoute, Link } from '@tanstack/react-router'
import type { CalendarEvent } from '../../../src/calendar'
import { getDay } from '../todo-fns'
import { done, focusToggle, Section, TodoRow } from '../todo-parts'
import type { DayPage } from '../todos.server'

export const Route = createFileRoute('/today')({
  validateSearch: (s: Record<string, unknown>) => ({
    day: typeof s.day === 'string' ? s.day : 'today',
  }),
  loaderDeps: ({ search }) => ({ day: search.day }),
  loader: ({ deps }) => getDay({ data: deps.day }),
  component: TodayPage,
})

const GROUPS = [
  ['overdue', 'Overdue'],
  ['scheduled', 'Scheduled'],
  ['due', 'Due'],
  ['focus', 'Focus'],
] as const

// `nod today`: what the day holds for certain, then what was picked for it. Above them, whether
// the lists can be trusted (`nod todo check`).
function TodayPage() {
  const page = Route.useLoaderData()
  const weekday = new Date(`${page.day}T12:00`).toLocaleDateString('en-US', { weekday: 'long' })
  const empty = GROUPS.every(([key]) => page.groups[key].length === 0)
  return (
    <div className="page">
      <h1 className="title">
        {weekday}, {page.day}
      </h1>
      <div className="filters">
        <Link
          to="/today"
          search={{ day: 'today' }}
          activeOptions={{ includeSearch: true }}
          activeProps={{ className: 'on' }}
        >
          Today
        </Link>
        <Link
          to="/today"
          search={{ day: 'tomorrow' }}
          activeOptions={{ includeSearch: true }}
          activeProps={{ className: 'on' }}
        >
          Tomorrow
        </Link>
      </div>
      <Trust page={page} />

      <Section title="Events">
        <Events read={page.events} />
      </Section>

      {empty && <p className="muted">No todos for the day.</p>}
      {GROUPS.map(([key, name]) =>
        page.groups[key].length === 0 ? null : (
          <Section key={key} title={name}>
            {page.groups[key].map((t) => (
              <TodoRow
                key={t.id}
                t={t}
                today={page.day}
                actions={[focusToggle(t, page.day), done]}
              />
            ))}
          </Section>
        ),
      )}
    </div>
  )
}

function Trust({ page }: { page: DayPage }) {
  const t = page.trust
  return (
    <div className="stats">
      <Stat label="Inbox" value={String(t.inbox)}>
        {t.oldestInbox === null ? 'empty' : `since ${t.oldestInbox}`}
      </Stat>
      <Stat label="No next action" value={String(t.stuck.length)}>
        {t.stuck.map((p) => p.title).join(', ') || 'every active project has one'}
      </Stat>
      <Stat label="Waiting long" value={String(t.stale.length)}>
        {t.stale.map((s) => `${s.todo.waitingOn} (${s.days}d)`).join(', ') || 'none'}
      </Stat>
      <Stat label="Weekly review" value={t.sinceReview === null ? '—' : `${t.sinceReview}d`}>
        {t.sinceReview === null ? 'none done yet' : 'since the last'}
      </Stat>
    </div>
  )
}

function Stat({ label, value, children }: { label: string; value: string; children: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">{children}</div>
    </div>
  )
}

// A calendar that could not be read says so, since no events would read as a free day.
function Events({ read }: { read: DayPage['events'] }) {
  if (read.kind === 'error') {
    return (
      <div className="banner">
        Could not read the calendar, so no events are shown: {read.error}
      </div>
    )
  }
  if (read.kind === 'none') {
    return (
      <p className="muted">
        No calendar. On macOS, build one with <code>sh calendar/build.sh</code>.
      </p>
    )
  }
  if (read.events.length === 0) return <p className="muted">None.</p>
  return (
    <>
      {read.events.map((e) => (
        <div key={`${e.start}${e.title}`} className="todo-row">
          <div className="todo-line">
            <span className="event-time">{eventTime(e)}</span>
            <span className="todo-title">{e.title}</span>
          </div>
          <div className="todo-tags">
            <span>{e.calendar}</span>
            {e.location !== undefined && <span>{e.location}</span>}
            {e.myStatus === 'pending' && <span className="warn-text">not answered</span>}
          </div>
        </div>
      ))}
    </>
  )
}

const eventTime = (e: CalendarEvent): string =>
  e.allDay ? 'all day' : `${e.start.slice(11, 16)}–${e.end.slice(11, 16)}`
