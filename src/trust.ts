import { daysBetween, localDay } from './days'
import type { DayTodos, Project, Todo } from './todos'

// Whether the person can trust the lists. Each number is something that, left alone, lets the
// lists drift from what is really going on, until the person stops looking at them.

// The channel of the weekly review's repeating todo (`nod in … --source review`). A repeating
// todo's next one keeps its channel, so the last one done is the last weekly review.
export const REVIEW_SOURCE = 'review'
// A person or a watch waited on this long, with nothing recorded on the todo since, is due a
// reminder: a watch that fails for good shows here too.
export const STALE_DAYS = 7
// GTD's weekly review.
const REVIEW_DAYS = 7
// What nod tells a project went within 18.2 hours where a session heard (measured, docs/design.md
// 「전하지 못한 알림 보이기」); what waits longer than this is for a session, or helper, that is off.
export const UNTOLD_HOURS = 24

export type Trust = {
  inbox: number
  // The day the oldest inbox todo was captured.
  oldestInbox: string | null
  overdue: Todo[]
  // Scheduled for the day, or due on it.
  today: Todo[]
  // Active projects with no next action; an open decision on one of their tasks counts as one.
  stuck: Project[]
  // Waiting on a person or a watch, with no change to the todo since `since`, STALE_DAYS or more
  // ago.
  stale: { todo: Todo; since: string; days: number }[]
  // Days since the last weekly review; null before the first.
  sinceReview: number | null
  // Each project nod has had something to tell for over UNTOLD_HOURS: how many notices wait, how
  // many of those are words sent with nod tell, and the day of the oldest.
  untold: { project: Project; count: number; words: number; since: string }[]
}

export type TrustInput = {
  open: Todo[]
  projects: (Project & { next: number })[]
  // When each todo last changed, as recorded in its changes.
  lastChange: Map<number, string>
  lastReview: string | null
  day: DayTodos
  // What waits to be told of each project, oldest first.
  unsent: { project: Project; words: boolean; createdAt: string }[]
}

export function trust(s: TrustInput, today: string, now: Date): Trust {
  const daysSince = (iso: string) => daysBetween(localDay(new Date(iso)), today)
  const inbox = s.open.filter((t) => t.status === 'inbox')
  const waitingLong = s.open.filter(
    (t) => t.status === 'waiting' && (t.waitingOn !== null || t.watch !== null),
  )
  return {
    inbox: inbox.length,
    oldestInbox: inbox.map((t) => localDay(new Date(t.createdAt))).sort()[0] ?? null,
    overdue: s.day.overdue,
    today: [...s.day.scheduled, ...s.day.due],
    stuck: s.projects.filter((p) => p.next === 0),
    stale: waitingLong
      .map((todo) => {
        const last = s.lastChange.get(todo.id)
        if (last === undefined) throw new Error(`t${todo.id} has no recorded change`)
        return { todo, since: localDay(new Date(last)), days: daysSince(last) }
      })
      .filter((x) => x.days >= STALE_DAYS),
    sinceReview: s.lastReview === null ? null : daysSince(s.lastReview),
    untold: [...Map.groupBy(s.unsent, (n) => n.project.id).values()].flatMap((ns) => {
      const [oldest] = ns
      if (oldest === undefined) return []
      const at = new Date(oldest.createdAt)
      if (now.getTime() - at.getTime() <= UNTOLD_HOURS * 3_600_000) return []
      const words = ns.filter((n) => n.words).length
      return [{ project: oldest.project, count: ns.length, words, since: localDay(at) }]
    }),
  }
}

// The day the oldest inbox todo came in, once one has sat there overnight; else null.
export const inboxSince = (t: Trust, today: string): string | null =>
  t.oldestInbox !== null && t.oldestInbox < today ? t.oldestInbox : null

export const reviewDue = (t: Trust): boolean =>
  t.sinceReview !== null && t.sinceReview > REVIEW_DAYS

// One line for the day's first session, or null when nothing needs the person. The web's Focus
// page shows the same.
export function nudgeLine(t: Trust, today: string): string | null {
  const since = inboxSince(t, today)
  const parts = [
    t.overdue.length > 0 ? `overdue ${t.overdue.length}` : null,
    t.today.length > 0 ? `today ${t.today.length}` : null,
    since === null ? null : `inbox ${t.inbox} since ${since.slice(5)}`,
    t.stuck.length > 0 ? `no next action ${t.stuck.length}` : null,
    t.stale.length > 0 ? `waiting long ${t.stale.length}` : null,
    t.untold.length > 0
      ? `not told ${t.untold.map((u) => `p${u.project.id} ${u.count}`).join(', ')}`
      : null,
    reviewDue(t) ? `weekly review ${t.sinceReview} days ago` : null,
  ].filter((x) => x !== null)
  return parts.length === 0 ? null : `nod · ${parts.join(' · ')}`
}
