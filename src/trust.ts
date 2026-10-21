import { daysBetween, localDay } from './days'
import type { DayTodos, Project, Todo } from './todos'

// Whether the person can trust the lists. Each number is something that, left alone, lets the
// lists drift from what is really going on, until the person stops looking at them.

// The channel of the weekly review's repeating todo (`nod in … --source review`). A repeating
// todo's next one keeps its channel, so the last one done is the last weekly review.
export const REVIEW_SOURCE = 'review'
// A person waited on this long, with nothing recorded on the todo since, is due a reminder.
export const STALE_DAYS = 7
// GTD's weekly review.
export const REVIEW_DAYS = 7

export type Trust = {
  inbox: number
  // The day the oldest inbox todo was captured.
  oldestInbox: string | null
  overdue: Todo[]
  // Scheduled for the day, or due on it.
  today: Todo[]
  // Active projects with no next action; an open decision on one of their tasks counts as one.
  stuck: Project[]
  // Waiting on a person, with no change to the todo since `since`, STALE_DAYS or more ago.
  stale: { todo: Todo; since: string; days: number }[]
  // Days since the last weekly review; null before the first.
  sinceReview: number | null
}

export type TrustInput = {
  open: Todo[]
  projects: (Project & { next: number })[]
  // When each todo last changed, as recorded in its changes.
  lastChange: Map<number, string>
  lastReview: string | null
  day: DayTodos
}

export function trust(s: TrustInput, today: string): Trust {
  const daysSince = (iso: string) => daysBetween(localDay(new Date(iso)), today)
  const inbox = s.open.filter((t) => t.status === 'inbox')
  const waitingOnPeople = s.open.filter((t) => t.status === 'waiting' && t.waitingOn !== null)
  return {
    inbox: inbox.length,
    oldestInbox: inbox.map((t) => localDay(new Date(t.createdAt))).sort()[0] ?? null,
    overdue: s.day.overdue,
    today: [...s.day.scheduled, ...s.day.due],
    stuck: s.projects.filter((p) => p.next === 0),
    stale: waitingOnPeople
      .map((todo) => {
        const last = s.lastChange.get(todo.id)
        if (last === undefined) throw new Error(`t${todo.id} has no recorded change`)
        return { todo, since: localDay(new Date(last)), days: daysSince(last) }
      })
      .filter((x) => x.days >= STALE_DAYS),
    sinceReview: s.lastReview === null ? null : daysSince(s.lastReview),
  }
}

// One line for the day's first session, or null when nothing needs the person.
export function nudgeLine(t: Trust, today: string): string | null {
  const parts = [
    t.overdue.length > 0 ? `overdue ${t.overdue.length}` : null,
    t.today.length > 0 ? `today ${t.today.length}` : null,
    t.oldestInbox !== null && t.oldestInbox < today
      ? `inbox ${t.inbox} since ${t.oldestInbox.slice(5)}`
      : null,
    t.stuck.length > 0 ? `no next action ${t.stuck.length}` : null,
    t.stale.length > 0 ? `waiting long ${t.stale.length}` : null,
    t.sinceReview !== null && t.sinceReview > REVIEW_DAYS
      ? `weekly review ${t.sinceReview} days ago`
      : null,
  ].filter((x) => x !== null)
  return parts.length === 0 ? null : `nod · ${parts.join(' · ')}`
}
