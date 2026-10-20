import { parseArgs } from 'node:util'
import {
  type Change,
  OPEN,
  PROJECT_STATUSES,
  type Project,
  parseRef,
  TODO_STATUSES,
  type Todo,
  type Todos,
} from './todos'
import { indent, oneLine } from './view'

export const TODO_USAGE = `  nod in <what...> [--notes <text>] [--source <channel> --key <id>] [--link <url>]
                                   capture a todo into the inbox. A channel's key is captured
                                   once; capturing it again prints the todo it became
  nod todo [inbox|next|waiting|someday|reference] [--context <@x>] [--project <p>] [--all]
                                   todos (default: inbox, next and waiting; --all: every status,
                                   finished ones too). --context also lists todos with no
                                   context, which can be done anywhere. Todos of someday
                                   projects show only with --project or --all
  nod todo <todo>                  one todo: notes, links, and who changed what
  nod todo set <todo> [--status <s>] [--title <text>] [--notes <text>] [--project <p>]
                      [--context <@x>] [--waiting-on <who>] [--link <url>]...
                                   clarify and organize it; an empty value clears a field.
                                   Leaving waiting forgets whom it waited on
  nod todo done|drop <todo...>
  nod project add <title...> [--outcome <what done looks like>]
  nod project [ls] [--all]         active projects with their next and waiting counts; one with
                                   no next action says so (--all: every status)
  nod project <project>            one project: its open todos and who changed what
  nod project set <project> [--title <text>] [--outcome <text>] [--status <s>]
  nod project done <project>       only once none of its todos is open
                                   Todos are t<n>; projects are p<n> or their exact title. Each
                                   change records who made it: $NOD_ACTOR if set, else
                                   worker:<task> in a nod worker, claude:<session> in a Claude
                                   session, human otherwise`

// The lists `nod todo <list>` names. Finished todos are listed with --all, since `nod todo done`
// finishes todos.
const LISTS = ['inbox', 'next', 'waiting', 'someday', 'reference'] as const

// Who is changing a todo or a project. An explicit NOD_ACTOR wins (the web UI, a script); else a
// nod worker, a Claude session (by its session, so a change can be traced to it), or a person at
// a terminal.
export function actorFromEnv(env: Record<string, string | undefined> = process.env): string {
  if (env.NOD_ACTOR) return env.NOD_ACTOR
  if (env.NOD_TASK) return `worker:${env.NOD_TASK}`
  if (env.CLAUDECODE) {
    const session = env.CLAUDE_CODE_SESSION_ID
    return session ? `claude:${session.slice(0, 8)}` : 'claude'
  }
  return 'human'
}

// `nod in`: capture first, clarify later, so it asks for nothing but the words.
export function capture(todos: Todos, args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      notes: { type: 'string' },
      source: { type: 'string' },
      key: { type: 'string' },
      link: { type: 'string' },
    },
  })
  const title = positionals.join(' ').trim()
  if (title === '') throw new Error(TODO_USAGE)
  if (values.key !== undefined && values.source === undefined) {
    throw new Error('--key needs --source: a key is the id a channel gave the item')
  }
  const { todo, created } = todos.capture(
    {
      title,
      notes: cleared(values.notes) ?? null,
      source: values.source ?? 'cli',
      sourceKey: values.key ?? null,
      url: values.link ?? null,
    },
    actorFromEnv(),
  )
  console.log(created ? line(todos, todo) : `${line(todos, todo)}  (already captured)`)
}

export function todoCommand(todos: Todos, args: string[]): void {
  const [sub, ...rest] = args
  if (sub === 'set') {
    setTodo(todos, rest)
  } else if (sub === 'done' || sub === 'drop') {
    finishTodos(todos, sub, rest)
  } else if (sub !== undefined && /^t?\d+$/.test(sub) && rest.length === 0) {
    showTodo(todos, parseRef(sub, 't'))
  } else {
    listTodos(todos, args)
  }
}

function listTodos(todos: Todos, args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      context: { type: 'string' },
      project: { type: 'string' },
      all: { type: 'boolean' },
    },
  })
  const [which, ...extra] = positionals
  const list = LISTS.find((s) => s === which)
  if (extra.length > 0 || (which !== undefined && list === undefined)) throw new Error(TODO_USAGE)
  if (values.all && list !== undefined) {
    throw new Error(`--all lists every status; leave out ${list}`)
  }
  const shown = todos.list({
    statuses: values.all ? [...TODO_STATUSES] : list !== undefined ? [list] : OPEN,
    context: values.context ?? null,
    projectId: values.project === undefined ? null : todos.findProject(values.project).id,
    hideSomedayProjects: !values.all && values.project === undefined,
  })
  for (const t of shown) console.log(line(todos, t))
}

function setTodo(todos: Todos, args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      status: { type: 'string' },
      title: { type: 'string' },
      notes: { type: 'string' },
      project: { type: 'string' },
      context: { type: 'string' },
      'waiting-on': { type: 'string' },
      link: { type: 'string', multiple: true },
    },
  })
  const [ref, ...extra] = positionals
  if (ref === undefined || extra.length > 0) throw new Error(TODO_USAGE)
  const status = TODO_STATUSES.find((s) => s === values.status)
  if (values.status !== undefined && status === undefined) {
    throw new Error(`a todo status is one of ${TODO_STATUSES.join(', ')}`)
  }
  const { project } = values
  const todo = todos.set(
    parseRef(ref, 't'),
    {
      status,
      title: values.title,
      notes: cleared(values.notes),
      context: cleared(values.context),
      waitingOn: cleared(values['waiting-on']),
      projectId:
        project === undefined ? undefined : project === '' ? null : todos.findProject(project).id,
    },
    actorFromEnv(),
    values.link ?? [],
  )
  console.log(line(todos, todo))
}

function finishTodos(todos: Todos, sub: 'done' | 'drop', refs: string[]): void {
  if (refs.length === 0) {
    throw new Error(`name the todos: nod todo ${sub} t<n>...; finished todos list with --all`)
  }
  const ids = refs.map((r) => parseRef(r, 't'))
  const finished = todos.finish(ids, sub === 'done' ? 'done' : 'dropped', actorFromEnv())
  for (const t of finished) console.log(line(todos, t))
}

function showTodo(todos: Todos, id: number): void {
  const t = todos.get(id)
  console.log(`t${t.id} ${t.status}: ${t.title}`)
  const where = tags(todos, t)
  if (where.length > 0) console.log(`  ${where.join(' · ')}`)
  console.log(`  from ${t.source}${t.sourceKey === null ? '' : ` ${t.sourceKey}`}`)
  for (const l of todos.links(id)) {
    console.log(`  link ${l.url}${l.title === null ? '' : ` (${l.title})`}`)
  }
  if (t.notes !== null) console.log(`  notes\n${indent(t.notes, 4)}`)
  printChanges(todos.changes(id))
}

export function projectCommand(todos: Todos, args: string[]): void {
  const [sub, ...rest] = args
  if (sub === 'add') {
    addProject(todos, rest)
  } else if (sub === undefined || sub === 'ls' || sub === '--all') {
    listProjects(todos, sub === 'ls' ? rest : args)
  } else if (sub === 'set') {
    setProject(todos, rest)
  } else if (sub === 'done') {
    const [ref, ...extra] = rest
    if (ref === undefined || extra.length > 0) throw new Error(TODO_USAGE)
    const p = todos.findProject(ref)
    console.log(projectLine(todos.setProject(p.id, { status: 'done' }, actorFromEnv())))
  } else if (rest.length === 0) {
    showProject(todos, todos.findProject(sub))
  } else {
    throw new Error(TODO_USAGE)
  }
}

function addProject(todos: Todos, args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { outcome: { type: 'string' } },
  })
  const title = positionals.join(' ').trim()
  if (title === '') throw new Error(TODO_USAGE)
  const outcome = cleared(values.outcome) ?? null
  console.log(projectLine(todos.addProject({ title, outcome }, actorFromEnv())))
}

function listProjects(todos: Todos, args: string[]): void {
  const { values } = parseArgs({ args, options: { all: { type: 'boolean' } } })
  for (const p of todos.projects(values.all ? [...PROJECT_STATUSES] : ['active'])) {
    const counts = `${p.next} next  ${p.waiting} waiting`
    const stuck = p.status === 'active' && p.next === 0 ? '  · no next action' : ''
    console.log(`${projectLine(p)}  ${counts}${stuck}`)
  }
}

function setProject(todos: Todos, args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      outcome: { type: 'string' },
      status: { type: 'string' },
    },
  })
  const [ref, ...extra] = positionals
  if (ref === undefined || extra.length > 0) throw new Error(TODO_USAGE)
  const status = PROJECT_STATUSES.find((s) => s === values.status)
  if (values.status !== undefined && status === undefined) {
    throw new Error(`a project status is one of ${PROJECT_STATUSES.join(', ')}`)
  }
  const p = todos.findProject(ref)
  const edit = { title: values.title, outcome: cleared(values.outcome), status }
  console.log(projectLine(todos.setProject(p.id, edit, actorFromEnv())))
}

function showProject(todos: Todos, p: Project): void {
  console.log(projectLine(p))
  const open = { statuses: OPEN, context: null, projectId: p.id, hideSomedayProjects: false }
  for (const t of todos.list(open)) console.log(`  ${line(todos, t)}`)
  printChanges(todos.projectChanges(p.id))
}

// An option given as an empty string clears the field; one not given leaves it alone.
const cleared = (v: string | undefined): string | null | undefined => (v === '' ? null : v)

function line(todos: Todos, t: Todo): string {
  const rest = tags(todos, t)
  const after = rest.length > 0 ? `  · ${rest.join(' · ')}` : ''
  return `t${String(t.id).padEnd(4)} ${t.status.padEnd(9)} ${oneLine(t.title, 80)}${after}`
}

function tags(todos: Todos, t: Todo): string[] {
  const project = t.projectId === null ? null : todos.project(t.projectId)
  const finished = t.status === 'done' || t.status === 'dropped'
  return [
    t.context,
    project === null ? null : `p${project.id} ${project.title}`,
    t.status === 'waiting' && t.waitingOn !== null ? `waiting on ${t.waitingOn}` : null,
    t.status === 'inbox' || t.status === 'waiting' ? `since ${localTime(t.statusAt)}` : null,
    finished ? `on ${localTime(t.statusAt)}` : null,
  ].filter((x) => x !== null)
}

const projectLine = (p: Project): string => {
  const outcome = p.outcome === null ? '' : ` — ${oneLine(p.outcome, 60)}`
  return `p${String(p.id).padEnd(4)} ${p.status.padEnd(8)} ${p.title}${outcome}`
}

function printChanges(changes: Change[]): void {
  console.log('  changes')
  for (const c of changes) {
    const fields = Object.entries(c.change).map(
      ([field, [from, to]]) =>
        `${FIELD[field] ?? field} ${shown(field, from)} → ${shown(field, to)}`,
    )
    console.log(`    ${localTime(c.at)}  ${c.actor}  ${fields.join(', ')}`)
  }
}

const FIELD: Record<string, string> = {
  projectId: 'project',
  waitingOn: 'waiting on',
  sourceKey: 'key',
}
const shown = (field: string, v: unknown): string => {
  if (v === null) return '—'
  return field === 'projectId' ? `p${String(v)}` : oneLine(String(v), 40)
}
const localTime = (iso: string): string => new Date(iso).toLocaleString('sv-SE').slice(0, 16)
