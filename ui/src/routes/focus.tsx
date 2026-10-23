import { createFileRoute, Link } from '@tanstack/react-router'
import { Fragment, useState } from 'react'
import type { CalendarEvent } from '../../../src/calendar'
import { inboxSince, reviewDue } from '../../../src/trust'
import { getFocus } from '../todo-fns'
import { relDay, Section, TodoRow } from '../todo-parts'
import type { EventsRead, FocusPage as Page, TodoItem } from '../todos.server'

export const Route = createFileRoute('/focus')({
  loader: () => getFocus(),
  component: FocusPage,
})

// The day's first screen, after Mindwtr's Focus: what needs the person, the day's events, the few
// todos picked for today, what the day holds, the next actions to pick from, those that start
// later, and reference to look up.
function FocusPage() {
  const page = Route.useLoaderData()
  const [context, setContext] = useState<string | null>(null)
  const contexts = [
    ...new Set(page.next.flatMap((t) => (t.context === null ? [] : [t.context]))),
  ].sort()
  // A next action with no context can be done anywhere, so it shows in every context.
  const next = page.next.filter(
    (t) => context === null || t.context === null || t.context === context,
  )
  // A full focus offers no more picks; unfocusing one makes room.
  const full = page.focus.length >= page.limit
  const rows = (ts: TodoItem[]) =>
    ts.map((t) => <TodoRow key={t.id} t={t} today={page.today} usual="next" full={full} />)
  const date = new Date(`${page.today}T12:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
  const free = page.events.kind === 'events' && page.events.events.length === 0
  return (
    <div className="page">
      <h1 className="title">Focus</h1>
      <p className="subtitle">
        {date}
        {free && ' · No events'}
      </p>
      <Attention page={page} />
      <Events read={page.events} />

      <Section
        title="Today's focus"
        count={`${page.focus.length}/${page.limit}`}
        bare={page.focus.length === 0}
      >
        {page.focus.length === 0 ? (
          <p className="muted placeholder">
            Nothing picked yet. Star up to {page.limit} next actions below.
          </p>
        ) : (
          rows(page.focus)
        )}
      </Section>
      {full && <p className="muted small">Full. Unstar one to pick another.</p>}

      {page.day.length > 0 && (
        <Section title="Today" count={page.day.length}>
          {rows(page.day)}
        </Section>
      )}

      <Section title="Next actions" count={page.next.length} bare={page.next.length === 0}>
        {contexts.length > 0 && (
          <div className="filters">
            {[null, ...contexts].map((c) => (
              <button
                key={c ?? ''}
                type="button"
                className={context === c ? 'on' : ''}
                onClick={() => setContext(c)}
              >
                {c ?? 'Anywhere'}
              </button>
            ))}
          </div>
        )}
        {page.next.length === 0 ? <p className="muted">None.</p> : rows(next)}
      </Section>

      {page.upcoming.length > 0 && (
        <Section title="Upcoming" count={page.upcoming.length}>
          {rows(page.upcoming)}
        </Section>
      )}

      <Reference ts={page.reference} today={page.today} />
    </div>
  )
}

// Reference is looked up, not worked from, so it stays folded at the bottom.
function Reference({ ts, today }: { ts: TodoItem[]; today: string }) {
  if (ts.length === 0) return null
  return (
    <details className="fold">
      <summary className="section fold-label">
        Reference
        <span className="count">{ts.length}</span>
      </summary>
      <div className="list">
        {ts.map((t) => (
          <TodoRow key={t.id} t={t} today={today} usual="reference" />
        ))}
      </div>
    </details>
  )
}

// What keeps the lists from being trusted, as the day's first session is nudged, and only what
// needs the person: what is overdue or due today has its own list below. Each line leads to where
// it is dealt with; a stuck project to its own card.
function Attention({ page }: { page: Page }) {
  const t = page.trust
  const since = inboxSince(t, page.today)
  const needs = [
    since !== null && (
      <Link key="inbox" to="/inbox">
        {t.inbox} in the inbox since {relDay(since, page.today)}
      </Link>
    ),
    t.stuck.length > 0 && (
      <span key="stuck">
        <span>
          No next action:{' '}
          {t.stuck.map((p, i) => (
            <Fragment key={p.id}>
              {i > 0 && ', '}
              <Link to="/projects" hash={`p${p.id}`}>
                {p.title}
              </Link>
            </Fragment>
          ))}
        </span>
      </span>
    ),
    t.stale.length > 0 && (
      <Link key="waiting" to="/waiting">
        Waiting long:{' '}
        {t.stale.map((s) => `${s.todo.waitingOn ?? s.todo.title} (${s.days}d)`).join(', ')}
      </Link>
    ),
    reviewDue(t) && <span key="review">Weekly review {t.sinceReview} days ago</span>,
  ].filter((x) => x !== false)
  if (needs.length === 0) return null
  return <div className="needs">{needs}</div>
}

// A calendar that could not be read says so, since no events would read as a free day.
function Events({ read }: { read: EventsRead }) {
  if (read.kind === 'error') {
    return (
      <div className="banner">
        Could not read the calendar, so no events are shown: {read.error}
      </div>
    )
  }
  if (read.kind === 'none' || read.events.length === 0) return null
  return (
    <Section title="Events" count={read.events.length}>
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
    </Section>
  )
}

const eventTime = (e: CalendarEvent): string =>
  e.allDay ? 'all day' : `${e.start.slice(11, 16)}–${e.end.slice(11, 16)}`
