import type { Database } from 'bun:sqlite'
import type { Compilable, Generated } from 'kysely'
import { z } from 'zod'
import {
  type Dates,
  dayOf,
  localDay,
  localTime,
  nextDates,
  parseWhen,
  REPEATS,
  type Repeat,
} from './days'
import {
  type Decision,
  type Ledger,
  type NewTask,
  now,
  queryBuilder,
  runQuery,
  type Task,
  type TaskStatus,
} from './ledger'
import { REVIEW_SOURCE, type Trust, trust } from './trust'

// The person's own todos, kept the GTD way: captured into the inbox, clarified into a next action,
// something waited on, someday, or reference, and grouped into projects. A todo is not a task: it
// is something to do, which a task may later do for the person.

export const TODO_STATUSES = [
  'inbox',
  'next',
  'waiting',
  'someday',
  'reference',
  'done',
  'dropped',
] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]
export const PROJECT_STATUSES = ['active', 'someday', 'done', 'dropped'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]
// Todos that still ask something of the person.
export const OPEN: TodoStatus[] = ['inbox', 'next', 'waiting']
const CLOSED_PROJECT: ProjectStatus[] = ['done', 'dropped']
// A delegated todo's tasks that may still go on: one in error can be resumed.
const UNFINISHED: TaskStatus[] = ['queued', 'running', 'needs_decision', 'error']

export type Todo = {
  id: number
  title: string
  notes: string | null
  status: TodoStatus
  projectId: number | null
  // One GTD context, such as `@computer`: where, or with what, the action can be done. A todo
  // without one can be done anywhere.
  context: string | null
  // Who the todo waits on while it is `waiting`. Empty while it waits on the tasks it was
  // delegated to.
  waitingOn: string | null
  // Dates are local days, `YYYY-MM-DD`, with ` HH:MM` where a time is allowed (days.ts).
  // The day, or the time, it must be done by.
  due: string | null
  // A day- or time-specific action: the day, or the time, to do it. With the calendar's events,
  // these are what a day holds for certain.
  scheduled: string | null
  // The lists leave it out before this day.
  start: string | null
  // Done makes the next one, dated whole periods on (nextDates).
  repeat: Repeat | null
  // The day it was picked to focus on.
  focus: string | null
  // While it is `waiting`, a shell command that exits 0 once what it waits on has happened; nod's
  // tick runs it and then makes the todo a next action again.
  watch: string | null
  // With a watch, the latest task the todo was delegated to: once the watch passes, that task's
  // session hears what the watch printed and carries on, and the todo waits on it again.
  backTo: number | null
  // Where it was captured: `cli`, or the channel a scan read it from. With a key, that channel's
  // id for it, so the same item is captured only once.
  source: string
  sourceKey: string | null
  createdAt: string
  // When the status last changed: since when it has waited, or when it was done.
  statusAt: string
}

export type Project = {
  id: number
  title: string
  // What done looks like, so whoever proposes the next action knows what it is for.
  outcome: string | null
  status: ProjectStatus
  createdAt: string
  statusAt: string
}

// What clarifying and organizing a todo may change.
export type TodoEdit = Partial<
  Pick<
    Todo,
    | 'title'
    | 'notes'
    | 'status'
    | 'projectId'
    | 'context'
    | 'waitingOn'
    | 'due'
    | 'scheduled'
    | 'start'
    | 'repeat'
    | 'focus'
    | 'watch'
    | 'backTo'
  >
>
export type ProjectEdit = Partial<Pick<Project, 'title' | 'outcome' | 'status'>>
export type TodoLink = { url: string; title: string | null }
// A task doing a todo, with its last one-line report and where its result went.
export type TodoTask = { task: Task; summary: string | null; links: string[] }
// An open decision, which is a next action for the person, with the todo its task does.
export type TodoDecision = { decision: Decision; task: Task; todo: Todo | null }
// One change to a todo or a project: who made it, and each field's value before and after.
export type Change = { actor: string; change: Record<string, [unknown, unknown]>; at: string }
export type TodoFilter = {
  statuses: TodoStatus[]
  // Todos in this context, and those with none, which can be done anywhere.
  context: string | null
  projectId: number | null
  // Leaves out the todos of someday projects: putting a project off puts off its actions.
  hideSomedayProjects: boolean
  // Leaves out the todos that start after this day; null shows them.
  day: string | null
}
// What a number names (`nod search`, the UI's search box): the ref it is shown by, a one-line
// title, its status, and, for what a task page shows, that task.
export type Found = { id: number; ref: string; title: string; status: string } & (
  | { kind: 'todo' }
  | { kind: 'project' }
  | { kind: 'task' | 'retro' | 'decision'; taskId: number }
)
// What a search ref's prefix finds; a bare number finds every kind. `#` is how nod wrote a task
// before `n`, kept for the refs already written down.
const FINDS = {
  t: 'todo',
  n: 'task',
  '#': 'task',
  r: 'retro',
  p: 'project',
  d: 'decision',
} as const
// What a watch said when it last ran: its exit code and the end of its output.
export type WatchCheck = { watch: string; at: string; code: number; output: string }
// A Claude session `nod open` opened for a project, and the folder it was opened in, where Claude
// Code keeps its transcript and so where it is reopened. `socket`: where it takes messages while it
// runs, as its hooks last said (inbox.ts); null before they said, and once it ended.
export type ProjectSession = {
  id: number
  sessionId: string
  projectId: number
  cwd: string
  createdAt: string
  socket: string | null
}
// The project a session was opened for, and whether it is still that project's latest session,
// the one `nod open` goes back into.
export type SessionPlace = { session: ProjectSession; project: Project; latest: boolean }
// What a day holds besides its events, each todo once, in the first group it is in.
export type DayTodos = { overdue: Todo[]; scheduled: Todo[]; due: Todo[]; focus: Todo[] }

type ChangeRow = { id: Generated<number>; actor: string; change: string; at: string }
type Tables = {
  todos: Omit<Todo, 'id'> & { id: Generated<number> }
  projects: Omit<Project, 'id'> & { id: Generated<number> }
  todoLinks: { todoId: number; url: string; title: string | null; createdAt: string }
  todoChanges: ChangeRow & { todoId: number }
  watchChecks: { todoId: number } & WatchCheck
  projectChanges: ChangeRow & { projectId: number }
  projectSessions: Omit<ProjectSession, 'id'> & { id: Generated<number> }
}

const q = queryBuilder<Tables>()
const ChangeJson = z.record(z.string(), z.tuple([z.unknown(), z.unknown()]))

const REF_NAMES = {
  t: 'todo',
  p: 'project',
  r: 'retrospective',
  n: 'task',
  d: 'decision',
  c: 'trigger',
} as const

// `t12` for a todo, `p3` for a project, `r2` for a retrospective, `n5` for a task, `d7` for a
// decision, `c2` for a trigger. A bare number is refused unless `bare`: tasks, decisions and
// triggers took one before nod wrote their letters, and still do; `nod 12` answers a decision and
// `nod drop 12` ends a task, so a number meant for a todo must not read as either.
export function parseRef(ref: string, prefix: keyof typeof REF_NAMES, bare = false): number {
  const m = new RegExp(`^${prefix}${bare ? '?' : ''}(\\d+)$`).exec(ref)
  if (m?.[1] === undefined) {
    throw new Error(`not a ${REF_NAMES[prefix]}: ${ref} (write ${prefix}<n>)`)
  }
  return Number(m[1])
}

// GTD contexts start with `@`; `phone` and `@phone` are the same context.
export const asContext = (c: string): string => (c.startsWith('@') ? c : `@${c}`)

// Text up to its first newline, as it is: a brief or question as a title. view.ts firstLine also
// trims it and takes out control characters.
export const firstLineOf = (s: string): string => s.replace(/\n[\s\S]*/, '')

// Reads the tasks and decisions through the ledger and writes only the todo tables, so nothing in
// the ledger depends on todos.
export class Todos {
  private readonly db: Database

  constructor(readonly ledger: Ledger) {
    this.db = ledger.db
  }

  // Puts a new todo in the inbox, in the project when one is given. When the source has already
  // given this key, returns that todo as it is.
  capture(
    t: {
      title: string
      notes: string | null
      source: string
      sourceKey: string | null
      url: string | null
      projectId?: number | null
    },
    actor: string,
  ): { todo: Todo; created: boolean } {
    filled('title', t.title)
    filled('source', t.source)
    if (t.sourceKey !== null) filled('key', t.sourceKey)
    return this.db.transaction(() => {
      if (t.sourceKey !== null) {
        const found = this.first(
          q
            .selectFrom('todos')
            .selectAll()
            .where('source', '=', t.source)
            .where('sourceKey', '=', t.sourceKey),
        )
        if (found) return { todo: found, created: false }
      }
      const at = now()
      const id = this.insert(
        q
          .insertInto('todos')
          .values({
            title: t.title,
            notes: t.notes,
            status: 'inbox',
            source: t.source,
            sourceKey: t.sourceKey,
            createdAt: at,
            statusAt: at,
          })
          .returning('id'),
      )
      const created = { title: t.title, notes: t.notes, status: 'inbox', source: t.source }
      this.recordTodo(id, actor, diff({}, { ...created, sourceKey: t.sourceKey }), at)
      if (t.url !== null) this.link(id, t.url, null, actor)
      const { projectId = null } = t
      if (projectId !== null) this.set(id, { projectId }, actor)
      return { todo: this.get(id), created: true }
    })()
  }

  get(id: number): Todo {
    const todo = this.first(q.selectFrom('todos').selectAll().where('id', '=', id))
    if (!todo) throw new Error(`no todo t${id}`)
    return todo
  }

  list(f: TodoFilter): Todo[] {
    const { context, projectId } = f
    const query = q
      .selectFrom('todos')
      .selectAll()
      .where((eb) =>
        eb.and([
          eb('status', 'in', f.statuses),
          ...(context === null
            ? []
            : [eb.or([eb('context', '=', asContext(context)), eb('context', 'is', null)])]),
          ...(projectId === null ? [] : [eb('projectId', '=', projectId)]),
          ...(f.day === null ? [] : [eb.or([eb('start', 'is', null), eb('start', '<=', f.day)])]),
          ...(f.hideSomedayProjects
            ? [
                eb.or([
                  eb('projectId', 'is', null),
                  eb(
                    'projectId',
                    'not in',
                    eb.selectFrom('projects').select('id').where('status', '=', 'someday'),
                  ),
                ]),
              ]
            : []),
        ]),
      )
      .orderBy('id')
    const order = (t: Todo) => TODO_STATUSES.indexOf(t.status)
    return this.run(query).sort((a, b) => order(a) - order(b))
  }

  // Changes what the edit names, adds the links, and records who changed what, all or nothing.
  // Fields equal to the current value are not changes.
  set(id: number, edit: TodoEdit, actor: string, links: string[] = []): Todo {
    return this.db.transaction(() => {
      const before = this.get(id)
      const after = this.settle(before, edit)
      const change = diff(before, after)
      if (Object.keys(change).length > 0) {
        const at = now()
        const statusAt = 'status' in change ? at : before.statusAt
        this.run(
          q
            .updateTable('todos')
            .set({ ...after, statusAt })
            .where('id', '=', id),
        )
        this.recordTodo(id, actor, change, at)
        if ('status' in change && after.status === 'done') this.repeatNext(id, actor)
        // A new watch, or none, has not run yet.
        if ('watch' in change) this.run(q.deleteFrom('watchChecks').where('todoId', '=', id))
      }
      for (const url of links) this.link(id, url, null, actor)
      return this.get(id)
    })()
  }

  // Refuses the edit as `set` would, changing nothing, so slow work for it can wait until it holds.
  check(id: number, edit: TodoEdit): void {
    this.settle(this.get(id), edit)
  }

  // Marks every todo done or dropped, or none of them when one does not exist.
  finish(ids: number[], status: 'done' | 'dropped', actor: string): Todo[] {
    return this.db.transaction(() => ids.map((id) => this.set(id, { status }, actor)))()
  }

  // A todo brought from another system with its own times: when it was captured, when its status
  // last changed, and `at`, when it last moved, which becomes its one recorded change by `actor`.
  // Its values are checked as an edit's are.
  importTodo(t: Omit<Todo, 'id'>, links: TodoLink[], actor: string, at: string): number {
    filled('title', t.title)
    oneOf('todo status', t.status, TODO_STATUSES)
    if (t.repeat !== null) oneOf('repeat', t.repeat, REPEATS)
    for (const [field, when, time] of [
      ['due', t.due, true],
      ['scheduled', t.scheduled, true],
      ['start', t.start, false],
      ['focus', t.focus, false],
    ] as const) {
      if (when !== null && parseWhen(when, when.slice(0, 10), time) !== when) {
        throw new Error(`${field} is not a day${time ? ' or a time' : ''}: ${when}`)
      }
    }
    return this.db.transaction(() => {
      if (t.projectId !== null && OPEN.includes(t.status)) {
        const p = this.project(t.projectId)
        if (CLOSED_PROJECT.includes(p.status)) {
          throw new Error(`p${p.id} is ${p.status}; an open todo cannot be in it: ${t.title}`)
        }
      }
      const id = this.insert(q.insertInto('todos').values(t).returning('id'))
      const { createdAt: _, statusAt: __, ...fields } = t
      this.recordTodo(id, actor, diff({}, fields), at)
      for (const l of links) {
        filled('link', l.url)
        this.run(
          q
            .insertInto('todoLinks')
            .orIgnore()
            .values({ todoId: id, url: l.url, title: l.title, createdAt: at }),
        )
      }
      return id
    })()
  }

  // The same address twice is kept once.
  link(id: number, url: string, title: string | null, actor: string): void {
    filled('link', url)
    this.db.transaction(() => {
      this.get(id)
      const added = this.first(
        q
          .insertInto('todoLinks')
          .orIgnore()
          .values({ todoId: id, url, title, createdAt: now() })
          .returning('url'),
      )
      if (added) this.recordTodo(id, actor, { link: [null, url] }, now())
    })()
  }

  links(id: number): TodoLink[] {
    return this.run(
      q
        .selectFrom('todoLinks')
        .select(['url', 'title'])
        .where('todoId', '=', id)
        .orderBy('createdAt'),
    )
  }

  changes(id: number): Change[] {
    return this.run(
      q
        .selectFrom('todoChanges')
        .select(['actor', 'change', 'at'])
        .where('todoId', '=', id)
        .orderBy('id'),
    ).map(parsed)
  }

  // Hands the todo to a new task. It then waits on nod, with no one in `waitingOn` and no watch,
  // until followTasks moves it on. `projectId` puts it in that project as it goes; null leaves it
  // where it is.
  delegate(id: number, task: NewTask, actor: string, projectId: number | null = null): number {
    return this.db.transaction(() => {
      const todo = this.get(id)
      if (todo.status === 'done' || todo.status === 'dropped') {
        throw new Error(`t${id} is ${todo.status}; reopen it before delegating it`)
      }
      const taskId = this.ledger.addTodoTask(task, id)
      const placed = projectId === null ? {} : { projectId }
      this.set(id, { status: 'waiting', waitingOn: null, watch: null, ...placed }, actor)
      return taskId
    })()
  }

  // Gives a task the person hands over without a todo one of its own, so every such task waits in
  // their lists, in the project when one is given. The brief's first line is its title.
  delegateNew(task: NewTask, projectId: number | null, actor: string): number {
    return this.db.transaction(() => {
      const title = firstLineOf(task.brief)
      const { todo } = this.capture(
        { title, notes: null, source: 'nod', sourceKey: null, url: null, projectId },
        actor,
      )
      return this.delegate(todo.id, task, actor)
    })()
  }

  // A task by its number (`n5`, or `5`), by the todo it does (`t12`): that todo's latest task, so
  // the person can name their work by the todo alone, or by the retrospective it runs (`r3`), as ls
  // shows it.
  taskRef(ref: string): number {
    if (/^n?\d+$/.test(ref)) return parseRef(ref, 'n', true)
    if (ref.startsWith('r')) {
      const id = parseRef(ref, 'r')
      const task = this.ledger.list().find((t) => t.retroId === id)
      if (task === undefined) throw new Error(`r${id} not found`)
      return task.id
    }
    if (!ref.startsWith('t')) {
      // A number as Number reads it, as before (` 12`); `d5` or `c5` names no task.
      const n = Number(ref)
      if (ref.trim() !== '' && Number.isInteger(n)) return n
      throw new Error(`not a task: ${ref} (write n<n>, t<n> or r<n>)`)
    }
    const id = parseRef(ref, 't')
    const last = this.ledger.tasksOf(id).at(-1)
    if (last === undefined)
      throw new Error(`t${id} has no task; hand it over with nod add --todo t${id}`)
    return last.id
  }

  // What `t<n>`, `n<n>` (or `#<n>`), `r<n>`, `p<n>` or `d<n>` names, or, for a bare `<n>`, all that
  // n numbers: the todo, task, retrospective, project and decision, in that order. Anything else
  // names nothing. `status` names a task's state; callers that see the terminals pass taskStatus
  // (view.ts).
  find(ref: string, status: (t: Task) => string = (t) => t.status): Found[] {
    const m = /^([tn#rpd]?)(\d+)$/.exec(ref.trim())
    if (m === null) return []
    const prefix = m[1] as keyof typeof FINDS | ''
    const n = Number(m[2])
    const todo = this.first(q.selectFrom('todos').selectAll().where('id', '=', n))
    const project = this.first(q.selectFrom('projects').selectAll().where('id', '=', n))
    const { task, retro, decision } = this.ledger.numbered(n)
    const all: (Found | null)[] = [
      todo && { kind: 'todo', id: n, ref: `t${n}`, title: todo.title, status: todo.status },
      task && {
        kind: 'task',
        id: n,
        ref: `n${n}`,
        title: firstLineOf(task.brief),
        status: status(task),
        taskId: n,
      },
      retro && {
        kind: 'retro',
        id: n,
        ref: `r${n}`,
        title: `of n${retro.retro.ofTaskId}: ${firstLineOf(this.ledger.get(retro.retro.ofTaskId).brief)}`,
        status: retro.retro.outcome ?? status(retro.task),
        taskId: retro.task.id,
      },
      project && {
        kind: 'project',
        id: n,
        ref: `p${n}`,
        title: project.title,
        status: project.status,
      },
      decision && {
        kind: 'decision',
        id: n,
        ref: `d${n}`,
        title: firstLineOf(decision.question),
        status:
          decision.answer === null ? 'open' : decision.answeredAt === null ? 'closed' : 'answered',
        taskId: decision.taskId,
      },
    ]
    return all.filter((f): f is Found => f !== null && (prefix === '' || f.kind === FINDS[prefix]))
  }

  // Moves each todo waiting on nod along once none of its tasks can go on: done when the last one
  // succeeded, back to next when it was cancelled, so the person takes it back. Every such todo is
  // looked at, so those of tasks a cancel cascaded to move too. One with a watch waits on its watch,
  // even when its task is told more and ends again.
  followTasks(actor: string): void {
    const waiting = this.run(
      q
        .selectFrom('todos')
        .selectAll()
        .where('status', '=', 'waiting')
        .where('waitingOn', 'is', null)
        .where('watch', 'is', null),
    )
    for (const todo of waiting) {
      const tasks = this.ledger.tasksOf(todo.id)
      const last = tasks.at(-1)
      if (last === undefined || tasks.some((t) => UNFINISHED.includes(t.status))) continue
      // It finished before the todo began waiting: the person has set it waiting since, on no task.
      if (last.finishedAt === null || last.finishedAt < todo.statusAt) continue
      this.set(todo.id, { status: last.status === 'succeeded' ? 'done' : 'next' }, actor)
    }
  }

  // The waiting todos with a watch, which the tick runs.
  watched(): (Todo & { watch: string })[] {
    return this.run(
      q.selectFrom('todos').selectAll().where('status', '=', 'waiting').orderBy('id'),
    ).filter((t): t is Todo & { watch: string } => t.watch !== null)
  }

  // Keeps what a watch said when it ran, in place of what it said before.
  recordCheck(id: number, watch: string, code: number, output: string): void {
    const check = { watch, at: now(), code, output }
    this.run(
      q
        .insertInto('watchChecks')
        .values({ todoId: id, ...check })
        .onConflict((oc) => oc.column('todoId').doUpdateSet(check)),
    )
  }

  // What the todo's watch said when it last ran; null before it has run. One that ran while the
  // watch was changed is for the old watch, not this one.
  lastCheck(t: Todo): WatchCheck | null {
    if (t.watch === null) return null
    return this.first(
      q
        .selectFrom('watchChecks')
        .select(['watch', 'at', 'code', 'output'])
        .where('todoId', '=', t.id)
        .where('watch', '=', t.watch),
    )
  }

  // Makes a watched todo a next action again once its watch has ended, with a line in its notes
  // saying when and how: `passed`, or `cannot run (<why>)`. One that passed with a task to go back
  // to waits on that task instead, which moves it on when it ends (followTasks); the task is the
  // one it names now, not when the command started, so it is returned for the caller to tell. A
  // todo that left waiting or got another watch while the command ran is left as it is; null says so.
  endWatch(
    id: number,
    watch: string,
    outcome: string,
    actor: string,
    passed = false,
  ): { back: number | null } | null {
    return this.db.transaction(() => {
      const t = this.get(id)
      if (t.status !== 'waiting' || t.watch !== watch) return null
      const back = passed ? t.backTo : null
      const to = back === null ? '' : `, back to task n${back}`
      const line = `${localTime(new Date())} watch ${outcome}${to}: ${watch}`
      const notes = withLine(t.notes, line)
      const edit: TodoEdit = back === null ? { status: 'next' } : { waitingOn: null, watch: null }
      this.set(id, { ...edit, notes }, actor)
      return { back }
    })()
  }

  // Whom a waiting todo waits on: a person, or the tasks it was delegated to that can still go on.
  waitingFor(t: Todo): string | null {
    if (t.waitingOn !== null) return t.waitingOn
    const tasks = this.tasks(t.id).filter(({ task }) => UNFINISHED.includes(task.status))
    if (tasks.length === 0) return null
    return tasks.map(({ task }) => `task n${task.id} (${task.status})`).join(', ')
  }

  // The tasks doing the todo, oldest first.
  tasks(id: number): TodoTask[] {
    return this.ledger.tasksOf(id).map((task) => ({
      task,
      summary: this.ledger.lastAttempt(task.id)?.summary ?? null,
      links: this.ledger.links(task.id),
    }))
  }

  // Open decisions, oldest first.
  decisions(): TodoDecision[] {
    return this.ledger.openDecisions().map((decision) => {
      const task = this.ledger.get(decision.taskId)
      return { decision, task, todo: task.todoId === null ? null : this.get(task.todoId) }
    })
  }

  // The day's open todos: overdue (due or scheduled before the day), then those scheduled for it,
  // due on it, and picked for its focus.
  day(day: string): DayTodos {
    const open = this.run(
      q.selectFrom('todos').selectAll().where('status', 'in', OPEN).orderBy('id'),
    )
    const shown = new Set<number>()
    const group = (when: (t: Todo) => string | null, on: (when: string) => boolean): Todo[] => {
      const picked = open
        .flatMap((t) => {
          const w = when(t)
          return w !== null && on(w) && !shown.has(t.id) ? [{ t, w }] : []
        })
        .sort((a, b) => a.w.localeCompare(b.w))
        .map(({ t }) => t)
      for (const t of picked) shown.add(t.id)
      return picked
    }
    return {
      overdue: group(
        (t) => [t.due, t.scheduled].filter((w) => w !== null).sort()[0] ?? null,
        (w) => dayOf(w) < day,
      ),
      scheduled: group(
        (t) => t.scheduled,
        (w) => dayOf(w) === day,
      ),
      due: group(
        (t) => t.due,
        (w) => dayOf(w) === day,
      ),
      focus: group(
        (t) => t.focus,
        (w) => w === day,
      ),
    }
  }

  // What says whether the lists can be trusted, as of a day (trust.ts).
  trust(day: string): Trust {
    const changed = this.run(
      q
        .selectFrom('todoChanges')
        .select(['todoId', q.fn.max('at').as('at')])
        .groupBy('todoId'),
    )
    const reviewed = this.first(
      q
        .selectFrom('todos')
        .select(q.fn.max('statusAt').as('at'))
        .where('source', '=', REVIEW_SOURCE)
        .where('status', '=', 'done'),
    )
    const input = {
      open: this.run(q.selectFrom('todos').selectAll().where('status', 'in', OPEN).orderBy('id')),
      projects: this.projects(['active']),
      lastChange: new Map(changed.map((c) => [c.todoId, c.at])),
      lastReview: reviewed?.at ?? null,
      day: this.day(day),
    }
    return trust(input, day)
  }

  // ── projects ──

  addProject(p: { title: string; outcome: string | null }, actor: string): Project {
    projectTitle(p.title)
    return this.db.transaction(() => {
      const at = now()
      const id = this.insert(
        q
          .insertInto('projects')
          .values({ ...p, status: 'active', createdAt: at, statusAt: at })
          .returning('id'),
      )
      this.recordProject(id, actor, diff({}, { ...p, status: 'active' }), at)
      return this.project(id)
    })()
  }

  // A project brought from another system with its own times, recorded like importTodo.
  importProject(p: Omit<Project, 'id'>, actor: string, at: string): number {
    projectTitle(p.title)
    oneOf('project status', p.status, PROJECT_STATUSES)
    return this.db.transaction(() => {
      const id = this.insert(q.insertInto('projects').values(p).returning('id'))
      const { createdAt: _, statusAt: __, ...fields } = p
      this.recordProject(id, actor, diff({}, fields), at)
      return id
    })()
  }

  project(id: number): Project {
    const p = this.first(q.selectFrom('projects').selectAll().where('id', '=', id))
    if (!p) throw new Error(`no project p${id}`)
    return p
  }

  // `p3`, or a project's exact title. Titles never look like `p3` or `3` (projectTitle), so a bare
  // number is refused as a ref rather than looked up as a title.
  findProject(ref: string): Project {
    if (/^p?\d+$/.test(ref)) return this.project(parseRef(ref, 'p'))
    const found = this.run(q.selectFrom('projects').selectAll().where('title', '=', ref))
    const [one, ...more] = found
    if (!one) throw new Error(`no project titled "${ref}"`)
    if (more.length > 0) {
      throw new Error(`${found.map((p) => `p${p.id}`).join(', ')} are all titled "${ref}"`)
    }
    return one
  }

  // With how many next actions and waiting todos each has, so projects with no next action show.
  // An open decision on a task doing one of its todos counts as a next action: answering it is.
  projects(statuses: ProjectStatus[]): (Project & { next: number; waiting: number })[] {
    const open = this.run(
      q
        .selectFrom('todos')
        .select(['projectId', 'status'])
        .where('projectId', 'is not', null)
        .where('status', 'in', ['next', 'waiting']),
    )
    const decided = this.decisions().map((d) => ({ projectId: d.todo?.projectId, status: 'next' }))
    const counted = (id: number, status: TodoStatus) =>
      [...open, ...decided].filter((t) => t.projectId === id && t.status === status).length
    return this.run(
      q.selectFrom('projects').selectAll().where('status', 'in', statuses).orderBy('id'),
    ).map((p) => ({ ...p, next: counted(p.id, 'next'), waiting: counted(p.id, 'waiting') }))
  }

  // A project is finished only once nothing in it still asks something of the person, so no open
  // todo is left hanging under a closed project.
  setProject(id: number, edit: ProjectEdit, actor: string): Project {
    if (edit.title !== undefined) projectTitle(edit.title)
    if (edit.status !== undefined) oneOf('project status', edit.status, PROJECT_STATUSES)
    return this.db.transaction(() => {
      const before = this.project(id)
      if (edit.status !== undefined && CLOSED_PROJECT.includes(edit.status)) {
        const open = this.list({
          statuses: OPEN,
          context: null,
          projectId: id,
          hideSomedayProjects: false,
          day: null,
        })
        if (open.length > 0) {
          const ids = open.map((t) => `t${t.id}`).join(', ')
          throw new Error(`p${id} still has open todos ${ids}; finish or move them first`)
        }
      }
      const change = diff(before, edit)
      if (Object.keys(change).length === 0) return before
      const at = now()
      const statusAt = 'status' in change ? at : before.statusAt
      this.run(
        q
          .updateTable('projects')
          .set({ ...edit, statusAt })
          .where('id', '=', id),
      )
      this.recordProject(id, actor, change, at)
      return this.project(id)
    })()
  }

  projectChanges(id: number): Change[] {
    return this.run(
      q
        .selectFrom('projectChanges')
        .select(['actor', 'change', 'at'])
        .where('projectId', '=', id)
        .orderBy('id'),
    ).map(parsed)
  }

  // ── project sessions (nod open) ──

  // Records a Claude session opened for the project in `cwd`; from now on it is the project's.
  addSession(projectId: number, sessionId: string, cwd: string): ProjectSession {
    this.project(projectId)
    const row = { sessionId, projectId, cwd, createdAt: now(), socket: null }
    const id = this.insert(q.insertInto('projectSessions').values(row).returning('id'))
    return { id, ...row }
  }

  // Where a project session takes messages now; null once it ended. Nothing for a session nod open
  // did not open. With `from`, only while it is still that: one that started again since keeps the
  // socket it has now. A socket is one Claude Code process's, so the session there now takes it
  // from any other that had it: one that ended unheard, or went on under a new ID after /clear,
  // whose old ID the socket drops.
  setSocket(sessionId: string, socket: string | null, from?: string): void {
    this.db.transaction(() => {
      const set = q
        .updateTable('projectSessions')
        .set({ socket })
        .where('sessionId', '=', sessionId)
      this.run(from === undefined ? set : set.where('socket', '=', from))
      if (socket === null) return
      this.run(
        q
          .updateTable('projectSessions')
          .set({ socket: null })
          .where('socket', '=', socket)
          .where('sessionId', '!=', sessionId),
      )
    })()
  }

  // The project session nod tells at `socket`; null for none.
  sessionAt(socket: string): ProjectSession | null {
    return this.first(q.selectFrom('projectSessions').selectAll().where('socket', '=', socket))
  }

  // The project's latest session; null before nod open opened one.
  latestSession(projectId: number): ProjectSession | null {
    return this.first(
      q
        .selectFrom('projectSessions')
        .selectAll()
        .where('projectId', '=', projectId)
        .orderBy('id', 'desc')
        .limit(1),
    )
  }

  // Where a Claude session belongs; null for one nod open did not open.
  sessionPlace(sessionId: string): SessionPlace | null {
    const session = this.first(
      q.selectFrom('projectSessions').selectAll().where('sessionId', '=', sessionId),
    )
    if (session === null) return null
    const latest = this.latestSession(session.projectId)
    return { session, project: this.project(session.projectId), latest: latest?.id === session.id }
  }

  // ── whose work a task is ──

  // The project a task's work is in: its todo's; a retrospective's is that of the task it looks
  // back on.
  projectOf(task: Task): number | null {
    if (task.todoId !== null) return this.get(task.todoId).projectId
    if (task.retroId === null) return null
    return this.projectOf(this.ledger.get(this.ledger.retro(task.retroId).ofTaskId))
  }

  // Whether a task is the work of Claude session `session`: what --mine lists and watches, and the
  // session the task page names as its root. For a session nod open opened for a project, every
  // task in that project, whoever added it, so a new session for the project (another account,
  // --new, a long context) carries on with its tasks and decisions. Otherwise, and for a task in no
  // project, a task the session added. rootSession keeps who added a task either way.
  isMine(session: string, task: Task): boolean {
    const project = this.projectOf(task)
    const place = this.sessionPlace(session)
    if (place !== null && project !== null) return project === place.project.id
    return task.rootSession === session
  }

  // Whether the workers of two tasks may tell each other (NOD: tell): both in one project, which is
  // all one work for any session of it (isMine), or both added by one session.
  sameWork(a: Task, b: Task): boolean {
    const project = this.projectOf(a)
    if (project !== null && project === this.projectOf(b)) return true
    return a.rootSession !== null && a.rootSession === b.rootSession
  }

  // The session whose work a task is now, as nod show and the task page name its root: the latest
  // session of its project, else the session that added it while the task is still its work; null
  // when that is no session nod open opened.
  rootPlace(task: Task): SessionPlace | null {
    const project = this.projectOf(task)
    const session = (project === null ? null : this.latestSession(project))?.sessionId
    const root = session ?? task.rootSession
    return root !== null && this.isMine(root, task) ? this.sessionPlace(root) : null
  }

  // The todo as the edit leaves it, checked: a known status, a title, a project that is not
  // closed while the todo is open, a watch only while waiting. Leaving `waiting` forgets whom it
  // waited on, unless the edit names someone, and its watch.
  private settle(before: Todo, edit: TodoEdit): TodoEdit {
    if (edit.status !== undefined) oneOf('todo status', edit.status, TODO_STATUSES)
    if (edit.title !== undefined) filled('title', edit.title)
    if (typeof edit.context === 'string') filled('context', edit.context)
    if (typeof edit.watch === 'string') filled('watch', edit.watch)
    const status = edit.status ?? before.status
    if (typeof edit.watch === 'string' && status !== 'waiting') {
      throw new Error('a watch is for a waiting todo; give --status waiting with it')
    }
    // Its task's end moves it on; a watch passing first would leave the task's end nothing to move.
    if (
      typeof edit.watch === 'string' &&
      this.ledger.tasksOf(before.id).some((t) => UNFINISHED.includes(t.status))
    ) {
      throw new Error(`t${before.id} waits on its task, which moves it on when it ends`)
    }
    // It goes back to its latest task, the one followTasks moves it on with, which has a session to
    // go on in. One gc collected comes back when told (restore in worker.ts).
    if (typeof edit.backTo === 'number') {
      if ((edit.watch === undefined ? before.watch : edit.watch) === null || status !== 'waiting') {
        throw new Error('--back-to is for when a watch passes; give the waiting todo a --watch')
      }
      const task = this.ledger.tasksOf(before.id).at(-1)
      if (task?.id !== edit.backTo) {
        throw new Error(
          `task n${edit.backTo} is not the latest task of t${before.id}; give --back-to t${before.id}`,
        )
      }
      if (task.workspace === null) {
        throw new Error(`task n${task.id} never started, so it cannot carry on`)
      }
    }
    const projectId = edit.projectId === undefined ? before.projectId : edit.projectId
    if (projectId !== null && OPEN.includes(status)) {
      const p = this.project(projectId)
      if (CLOSED_PROJECT.includes(p.status)) {
        throw new Error(`p${p.id} is ${p.status}; an open todo cannot be in it`)
      }
    }
    if (edit.repeat !== undefined && edit.repeat !== null) oneOf('repeat', edit.repeat, REPEATS)
    const today = localDay(new Date())
    const when = (v: string | null | undefined, time: boolean) =>
      typeof v === 'string' ? parseWhen(v, today, time) : v
    const dates = {
      due: when(edit.due, true),
      scheduled: when(edit.scheduled, true),
      start: when(edit.start, false),
      focus: when(edit.focus, false),
    }
    const kept = (k: keyof Dates) => (dates[k] === undefined ? before[k] : dates[k])
    const repeat = edit.repeat === undefined ? before.repeat : edit.repeat
    if (
      repeat !== null &&
      kept('due') === null &&
      kept('scheduled') === null &&
      kept('start') === null
    ) {
      throw new Error('a repeating todo needs a due, on or start day to date its next one from')
    }
    const leftWaiting = before.status === 'waiting' && status !== 'waiting'
    return {
      ...edit,
      ...dates,
      ...(typeof edit.context === 'string' ? { context: asContext(edit.context) } : {}),
      ...(leftWaiting && edit.waitingOn === undefined ? { waitingOn: null } : {}),
      // The task to go back to is for when the watch passes, so it goes with the watch.
      ...(leftWaiting || edit.watch === null ? { watch: null, backTo: null } : {}),
    }
  }

  // The next one of a repeating todo just done; made once, however often this one is reopened and
  // done again. It keeps the source, so a series is known by its channel (the weekly review's is
  // `review`), and its key is the todo it follows.
  private repeatNext(id: number, actor: string): void {
    const done = this.get(id)
    if (done.repeat === null) return
    const sourceKey = `t${id}`
    const made = this.first(
      q
        .selectFrom('todos')
        .select('id')
        .where('source', '=', done.source)
        .where('sourceKey', '=', sourceKey),
    )
    if (made) return
    const fields = {
      title: done.title,
      notes: done.notes,
      status: 'next' as const,
      projectId: done.projectId,
      context: done.context,
      ...nextDates(done, done.repeat, localDay(new Date()), this.earlier(done)),
      repeat: done.repeat,
      source: done.source,
      sourceKey,
    }
    const at = now()
    const next = this.insert(
      q
        .insertInto('todos')
        .values({ ...fields, waitingOn: null, focus: null, createdAt: at, statusAt: at })
        .returning('id'),
    )
    this.recordTodo(next, actor, diff({}, fields), at)
  }

  // The todos of a monthly series before this one, latest first, through the key each next one
  // has (repeatNext); only a monthly series needs them (nextDates).
  // ponytail: reads the whole series though a date asks at most a few back; a series of years is
  // a few dozen rows.
  private earlier(t: Todo): Todo[] {
    if (t.repeat !== 'monthly') return []
    const before: Todo[] = []
    for (let at = t; ; ) {
      // A next one is made after the one it follows, so the walk only goes down, and ends.
      const id = Number(/^t(\d+)$/.exec(at.sourceKey ?? '')?.[1])
      if (!(id < at.id)) break
      const prev = this.first(
        q.selectFrom('todos').selectAll().where('id', '=', id).where('source', '=', at.source),
      )
      if (prev === null) break
      before.push(prev)
      at = prev
    }
    return before
  }

  private recordTodo(id: number, actor: string, change: Change['change'], at: string): void {
    this.run(
      q.insertInto('todoChanges').values({ todoId: id, actor, change: JSON.stringify(change), at }),
    )
  }

  private recordProject(id: number, actor: string, change: Change['change'], at: string): void {
    const row = { projectId: id, actor, change: JSON.stringify(change), at }
    this.run(q.insertInto('projectChanges').values(row))
  }

  private insert(query: Compilable<{ id: number }>): number {
    const row = this.first(query)
    if (!row) throw new Error('insert returned no id')
    return row.id
  }

  private run<O>(query: Compilable<O>): O[] {
    return runQuery(this.db, query)
  }

  private first<O>(query: Compilable<O>): O | null {
    return this.run(query)[0] ?? null
  }
}

const parsed = (r: { actor: string; change: string; at: string }): Change => ({
  ...r,
  change: ChangeJson.parse(JSON.parse(r.change)),
})

function filled(what: string, value: string): void {
  if (value.trim() === '') throw new Error(`empty ${what}`)
}

// A project title that reads as a ref (`p3`) or a number could not be found by its title.
function projectTitle(title: string): void {
  filled('title', title)
  if (/^p?\d+$/.test(title)) throw new Error(`a project title cannot look like p<n>: ${title}`)
}

// value as one of allowed, which narrows its type; anything else is refused.
export function oneOf<T extends string>(what: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((a) => a === value)
  if (found === undefined) throw new Error(`a ${what} is one of ${allowed.join(', ')}`)
  return found
}

// A field or option given as an empty string clears it; one not given leaves it alone.
export const cleared = (v: string | undefined): string | null | undefined => (v === '' ? null : v)

// The notes with line added below what they hold.
export const withLine = (notes: string | null, line: string): string =>
  [notes, line].filter((x) => x !== null).join('\n')

// Each field the edit sets to a value other than the current one, as [before, after]. Unset
// (undefined) fields are left out; a field set to null is a change when it was not null.
function diff(before: Record<string, unknown>, edit: Record<string, unknown>): Change['change'] {
  return Object.fromEntries(
    Object.entries(edit)
      .filter(([k, v]) => v !== undefined && v !== (before[k] ?? null))
      .map(([k, v]) => [k, [before[k] ?? null, v]]),
  )
}
