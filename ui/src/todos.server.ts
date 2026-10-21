// The todo pages' data, and the changes a person makes there. Server only, like nod.server.ts, and
// through the same ledger.
import { type CalendarEvent, readEvents } from '../../src/calendar'
import { localDay, parseWhen, REPEATS } from '../../src/days'
import {
  type DayTodos,
  PROJECT_STATUSES,
  type Project,
  TODO_STATUSES,
  type Todo,
  type TodoEdit,
  type TodoLink,
  type TodoStatus,
  Todos,
  type TodoTask,
} from '../../src/todos'
import type { Trust } from '../../src/trust'
import { changeText } from '../../src/view'
import { message } from '../../src/worker'
import type { RawEdit, RawProjectEdit } from './input'
import { home, ledger } from './nod.server'

// Changes made here record this actor. The server may run inside a Claude session, where the
// environment would make them claude's.
const ACTOR = 'human:ui'
// Reading the calendar launches an app, and the pages reload every few seconds.
const CALENDAR_TTL_MS = 5 * 60_000
// Today's focus holds this many, as in Mindwtr by default: picking few is the point.
const FOCUS_LIMIT = 3

const todos = new Todos(ledger)

// A todo with what its row shows: its project's title, and whom it waits on.
export type TodoItem = Todo & { project: string | null; waitingFor: string | null }

export type DecisionItem = {
  id: number
  reason: string
  createdAt: string
  taskId: number
  // The todo's title when the task does one, else the task's brief.
  title: string
  project: string | null
}

export type Lists = {
  // The server's day, so the page marks today's focus as the ledger counts it.
  today: string
  decisions: DecisionItem[]
  inbox: TodoItem[]
  next: TodoItem[]
  waiting: TodoItem[]
  someday: TodoItem[]
  reference: TodoItem[]
  contexts: string[]
  // The projects a todo can go in.
  projects: Project[]
}

export type TodoPage = {
  today: string
  todo: TodoItem
  links: TodoLink[]
  tasks: TodoTask[]
  // As `nod todo <todo>` prints them.
  changes: { actor: string; at: string; text: string }[]
  projects: Project[]
}

export type EventsRead =
  | { kind: 'events'; events: CalendarEvent[] }
  | { kind: 'none' }
  | { kind: 'error'; error: string }

export type DayPage = {
  day: string
  events: EventsRead
  groups: { [K in keyof DayTodos]: TodoItem[] }
  trust: Trust
}

// Mindwtr's Focus screen.
export type FocusPage = {
  today: string
  limit: number
  focus: TodoItem[]
  // Overdue, scheduled for today or due today, and not in the focus.
  day: TodoItem[]
  // The other next actions, those focused on an earlier day first: to pick again or let go.
  next: TodoItem[]
  // Next actions that start after today, the soonest first.
  upcoming: TodoItem[]
}

export type ProjectsPage = {
  today: string
  projects: (Project & { next: number; waiting: number; todos: TodoItem[] })[]
}

const item = (t: Todo): TodoItem => ({
  ...t,
  project: t.projectId === null ? null : todos.project(t.projectId).title,
  waitingFor: t.status === 'waiting' ? todos.waitingFor(t) : null,
})

const projectTitle = (id: number | null): string | null =>
  id === null ? null : todos.project(id).title

// As `nod todo` lists them: todos that start later and those of someday projects stay out.
export function lists(): Lists {
  const day = localDay(new Date())
  const of = (status: TodoStatus): TodoItem[] =>
    todos
      .list({ statuses: [status], context: null, projectId: null, hideSomedayProjects: true, day })
      .map(item)
  const next = of('next')
  return {
    today: day,
    decisions: todos.decisions().map(({ decision, task, todo }) => ({
      id: decision.id,
      reason: decision.reason,
      createdAt: decision.createdAt,
      taskId: task.id,
      title: todo?.title ?? task.brief,
      project: projectTitle(todo?.projectId ?? null),
    })),
    inbox: of('inbox'),
    next,
    waiting: of('waiting'),
    someday: of('someday'),
    reference: of('reference'),
    contexts: [...new Set(next.flatMap((t) => (t.context === null ? [] : [t.context])))].sort(),
    projects: todos.projects(['active', 'someday']),
  }
}

export function todoPage(id: number): TodoPage {
  return {
    today: localDay(new Date()),
    todo: item(todos.get(id)),
    links: todos.links(id),
    tasks: todos.tasks(id),
    changes: todos.changes(id).map((c) => ({ actor: c.actor, at: c.at, text: changeText(c) })),
    projects: todos.projects(['active', 'someday']),
  }
}

// One read per day at a time, kept for a while; a failed read is kept too, so the page says why.
const calendar = new Map<string, { at: number; read: Promise<EventsRead> }>()

function events(day: string): Promise<EventsRead> {
  const hit = calendar.get(day)
  if (hit !== undefined && Date.now() - hit.at < CALENDAR_TTL_MS) return hit.read
  const read = readEvents(home, day, 1).then(
    (events): EventsRead => (events === null ? { kind: 'none' } : { kind: 'events', events }),
    (error: unknown): EventsRead => ({ kind: 'error', error: message(error) }),
  )
  calendar.set(day, { at: Date.now(), read })
  return read
}

export async function dayPage(when: string): Promise<DayPage> {
  const today = localDay(new Date())
  const day = parseWhen(when, today, false)
  const groups = todos.day(day)
  return {
    day,
    events: await events(day),
    groups: {
      overdue: groups.overdue.map(item),
      scheduled: groups.scheduled.map(item),
      due: groups.due.map(item),
      focus: groups.focus.map(item),
    },
    trust: todos.trust(today),
  }
}

export function focusPage(): FocusPage {
  const today = localDay(new Date())
  const d = todos.day(today)
  // The day's groups do not overlap, and a focused todo that is also due today sits under due.
  const ofDay = [...d.overdue, ...d.scheduled, ...d.due, ...d.focus]
  const shown = new Set(ofDay.map((t) => t.id))
  const next = (day: string | null): Todo[] =>
    todos.list({
      statuses: ['next'],
      context: null,
      projectId: null,
      hideSomedayProjects: true,
      day,
    })
  const earlier = (t: Todo): number => (t.focus !== null && t.focus < today ? 0 : 1)
  return {
    today,
    limit: FOCUS_LIMIT,
    focus: ofDay.filter((t) => t.focus === today).map(item),
    day: ofDay.filter((t) => t.focus !== today).map(item),
    next: next(today)
      .filter((t) => !shown.has(t.id))
      .sort((a, b) => earlier(a) - earlier(b))
      .map(item),
    upcoming: next(null)
      .filter((t) => t.start !== null && t.start > today)
      .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
      .map(item),
  }
}

export function projectsPage(): ProjectsPage {
  return {
    today: localDay(new Date()),
    projects: todos.projects(['active', 'someday']).map((p) => ({
      ...p,
      todos: todos
        .list({
          statuses: ['inbox', 'next', 'waiting'],
          context: null,
          projectId: p.id,
          hideSomedayProjects: false,
          day: null,
        })
        .map(item),
    })),
  }
}

export const capture = (title: string): number =>
  todos.capture({ title, notes: null, source: 'ui', sourceKey: null, url: null }, ACTOR).todo.id

// A field sent empty is cleared, as `nod todo set` clears one given as ''.
const cleared = (v: string | undefined): string | null | undefined => (v === '' ? null : v)

function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  const found = allowed.find((a) => a === value)
  if (found === undefined) throw new Error(`a ${what} is one of ${allowed.join(', ')}`)
  return found
}

export function editTodo(id: number, raw: RawEdit): void {
  // A line added below the notes leaves what was there alone, as `nod todo set --add-note`.
  const added = raw.addNote?.trim() ?? ''
  if (added !== '' && raw.notes !== undefined) throw new Error('replace the notes or add a line')
  const edit: TodoEdit = {
    title: raw.title,
    notes:
      added === ''
        ? cleared(raw.notes)
        : [todos.get(id).notes, added].filter((x) => x !== null).join('\n'),
    status: raw.status === undefined ? undefined : oneOf(raw.status, TODO_STATUSES, 'todo status'),
    projectId: raw.projectId,
    context: cleared(raw.context),
    waitingOn: cleared(raw.waitingOn),
    due: cleared(raw.due),
    scheduled: cleared(raw.scheduled),
    start: cleared(raw.start),
    repeat:
      raw.repeat === undefined
        ? undefined
        : raw.repeat === ''
          ? null
          : oneOf(raw.repeat, REPEATS, 'repeat'),
    focus: cleared(raw.focus),
  }
  todos.set(id, edit, ACTOR)
}

export const addProject = (title: string, outcome: string): number =>
  todos.addProject({ title, outcome: outcome.trim() === '' ? null : outcome }, ACTOR).id

export function editProject(id: number, raw: RawProjectEdit): void {
  const status =
    raw.status === undefined ? undefined : oneOf(raw.status, PROJECT_STATUSES, 'project status')
  todos.setProject(id, { title: raw.title, outcome: cleared(raw.outcome), status }, ACTOR)
}
