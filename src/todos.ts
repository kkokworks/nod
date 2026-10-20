import type { Database } from 'bun:sqlite'
import type { Compilable, Generated } from 'kysely'
import { z } from 'zod'
import { queryBuilder, runQuery } from './ledger'

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

export type Todo = {
  id: number
  title: string
  notes: string | null
  status: TodoStatus
  projectId: number | null
  // One GTD context, such as `@computer`: where, or with what, the action can be done. A todo
  // without one can be done anywhere.
  context: string | null
  // Who the todo waits on while it is `waiting`.
  waitingOn: string | null
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
  Pick<Todo, 'title' | 'notes' | 'status' | 'projectId' | 'context' | 'waitingOn'>
>
export type ProjectEdit = Partial<Pick<Project, 'title' | 'outcome' | 'status'>>
export type TodoLink = { url: string; title: string | null }
// One change to a todo or a project: who made it, and each field's value before and after.
export type Change = { actor: string; change: Record<string, [unknown, unknown]>; at: string }
export type TodoFilter = {
  statuses: TodoStatus[]
  // Todos in this context, and those with none, which can be done anywhere.
  context: string | null
  projectId: number | null
  // Leaves out the todos of someday projects: putting a project off puts off its actions.
  hideSomedayProjects: boolean
}

type ChangeRow = { id: Generated<number>; actor: string; change: string; at: string }
type Tables = {
  todos: Omit<Todo, 'id'> & { id: Generated<number> }
  projects: Omit<Project, 'id'> & { id: Generated<number> }
  todoLinks: { todoId: number; url: string; title: string | null; createdAt: string }
  todoChanges: ChangeRow & { todoId: number }
  projectChanges: ChangeRow & { projectId: number }
}

const q = queryBuilder<Tables>()
const now = (): string => new Date().toISOString()
const ChangeJson = z.record(z.string(), z.tuple([z.unknown(), z.unknown()]))

// `t12` for a todo, `p3` for a project. A bare number is refused: `nod 12` answers a decision and
// `nod drop 12` ends a task, so a number meant for a todo must not read as either.
export function parseRef(ref: string, prefix: 't' | 'p'): number {
  const m = new RegExp(`^${prefix}(\\d+)$`).exec(ref)
  if (m?.[1] === undefined) {
    throw new Error(`not a ${prefix === 't' ? 'todo' : 'project'}: ${ref} (write ${prefix}<n>)`)
  }
  return Number(m[1])
}

// GTD contexts start with `@`; `phone` and `@phone` are the same context.
const asContext = (c: string): string => (c.startsWith('@') ? c : `@${c}`)

export class Todos {
  constructor(private readonly db: Database) {}

  // Puts a new todo in the inbox. When the source has already given this key, returns that todo.
  capture(
    t: {
      title: string
      notes: string | null
      source: string
      sourceKey: string | null
      url: string | null
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
            projectId: null,
            context: null,
            waitingOn: null,
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
      }
      for (const url of links) this.link(id, url, null, actor)
      return this.get(id)
    })()
  }

  // Marks every todo done or dropped, or none of them when one does not exist.
  finish(ids: number[], status: 'done' | 'dropped', actor: string): Todo[] {
    return this.db.transaction(() => ids.map((id) => this.set(id, { status }, actor)))()
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
  projects(statuses: ProjectStatus[]): (Project & { next: number; waiting: number })[] {
    const open = this.run(
      q
        .selectFrom('todos')
        .select(['projectId', 'status'])
        .where('projectId', 'is not', null)
        .where('status', 'in', ['next', 'waiting']),
    )
    const counted = (id: number, status: TodoStatus) =>
      open.filter((t) => t.projectId === id && t.status === status).length
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

  // The todo as the edit leaves it, checked: a known status, a title, a project that is not
  // closed while the todo is open. Leaving `waiting` forgets whom it waited on, unless the edit
  // names someone.
  private settle(before: Todo, edit: TodoEdit): TodoEdit {
    if (edit.status !== undefined) oneOf('todo status', edit.status, TODO_STATUSES)
    if (edit.title !== undefined) filled('title', edit.title)
    if (typeof edit.context === 'string') filled('context', edit.context)
    const status = edit.status ?? before.status
    const projectId = edit.projectId === undefined ? before.projectId : edit.projectId
    if (projectId !== null && OPEN.includes(status)) {
      const p = this.project(projectId)
      if (CLOSED_PROJECT.includes(p.status)) {
        throw new Error(`p${p.id} is ${p.status}; an open todo cannot be in it`)
      }
    }
    const leftWaiting = before.status === 'waiting' && status !== 'waiting'
    return {
      ...edit,
      ...(typeof edit.context === 'string' ? { context: asContext(edit.context) } : {}),
      ...(leftWaiting && edit.waitingOn === undefined ? { waitingOn: null } : {}),
    }
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

function oneOf(what: string, value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) throw new Error(`a ${what} is one of ${allowed.join(', ')}`)
}

// Each field the edit sets to a value other than the current one, as [before, after]. Unset
// (undefined) fields are left out; a field set to null is a change when it was not null.
function diff(before: Record<string, unknown>, edit: Record<string, unknown>): Change['change'] {
  return Object.fromEntries(
    Object.entries(edit)
      .filter(([k, v]) => v !== undefined && v !== (before[k] ?? null))
      .map(([k, v]) => [k, [before[k] ?? null, v]]),
  )
}
