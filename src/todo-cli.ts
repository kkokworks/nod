import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type CalendarEvent, calendarBuild, readEvents } from './calendar'
import { addDays, dayOf, localDay, localTime, parseWhen, REPEATS, type Repeat } from './days'
import {
  type Change,
  OPEN,
  PROJECT_STATUSES,
  type Project,
  parseRef,
  TODO_STATUSES,
  type Todo,
  type TodoDecision,
  type Todos,
  type WatchCheck,
} from './todos'
import { SCHEDULE_OFF, scheduleEnv, tryWatch } from './triggers'
import { nudgeLine, STALE_DAYS, type Trust } from './trust'
import { changeText, indent, oneLine } from './view'
import { message, openSettings, transcriptPath } from './worker'

export const TODO_USAGE = `  nod in <what...> [--notes <text>] [--source <channel> --key <id>] [--link <url>]
         [--project <p>]
                                   capture a todo into the inbox, in the project when given. A
                                   channel's key is captured once; capturing it again prints the
                                   todo it became, left where it is
  nod todo [inbox|next|waiting|someday|reference] [--context <@x>] [--project <p>] [--all]
           [--json]
                                   todos (default: inbox, next and waiting; --all: every status,
                                   finished ones too). Open decisions come first, as next
                                   actions: answer with nod <decision> <answer>. --context also
                                   lists todos with no context, which can be done anywhere.
                                   Todos of someday projects show only with --project or --all,
                                   and todos that start later only with --all. --json prints
                                   each todo as a JSON line, with its links, and no decisions
  nod todo <todo>                  one todo: notes, links, the tasks it was delegated to (nod add
                                   --todo) with what they reported, and who changed what
  nod todo set <todo> [--status <s>] [--title <text>] [--notes <text> | --add-note <line>]
                      [--project <p>]
                      [--context <@x>] [--waiting-on <who>] [--link <url>]...
                      [--due <day>] [--on <day>] [--start <day>] [--focus <day>]
                      [--repeat daily|weekly|monthly] [--watch <command>] [--back-to <task>]
                                   clarify and organize it; an empty value clears a field.
                                   Leaving waiting forgets whom it waited on and its watch.
                                   --watch gives a waiting todo a command that nod's tick runs
                                   in <home> every 5 minutes (cd to a repo in it); once it exits
                                   0, or can no longer run, the todo is a next action again, with
                                   a note. It runs once when given, with the schedule's PATH; one
                                   that does not parse, passes already, or that the shell cannot
                                   run, is refused. When it last ran and how it ended show with
                                   the todo. Keep secrets out of it: it is kept in the notes and
                                   history. --back-to names the latest task the todo was handed to
                                   (t<n> for short): once the watch passes, that task's session
                                   hears what the watch printed and carries on, asking before
                                   anything that needs you, and the todo waits on it instead. A
                                   <day> is
                                   YYYY-MM-DD, today or tomorrow; --due and --on also take a time,
                                   '<day> HH:MM'. --on is a day- or time-specific action, --start
                                   leaves it out of the lists until that day, and --focus picks it
                                   for that day. Done makes a repeating todo's next one, its dates
                                   whole periods on from the schedule
  nod today [<day>] [--days <n>]   the day's events, read from macOS Calendar, then its open
                                   todos: overdue, scheduled, due, and picked for its focus.
                                   --days goes on for n days, showing those that hold something
  nod todo check [--nudge|--json]  whether the lists can be trusted: the inbox and its oldest
                                   todo, overdue, today, projects with no next action, people
                                   waited on with nothing recorded for ${STALE_DAYS} days, days since
                                   the last weekly review (the last done todo from --source
                                   review). --nudge prints it once a day as a Claude Code
                                   SessionStart message, and nothing when all is well; --json
                                   prints it all as JSON
  nod todo done|drop <todo...>
  nod project add <title...> [--outcome <what done looks like>]
  nod project [ls] [--all]         active projects with their next and waiting counts, open
                                   decisions among the next; one with no next action says so
                                   (--all: every status)
  nod project <project>            one project: its open todos and who changed what
  nod project set <project> [--title <text>] [--outcome <text>] [--status <s>]
  nod project done <project>       only once none of its todos is open
                                   Todos are t<n>; projects are p<n> or their exact title. Each
                                   change records who made it: $NOD_ACTOR if set, else
                                   worker:<task> in a nod worker, claude:<session> in a Claude
                                   session, human otherwise; nod when a delegated todo follows
                                   its task`

// The lists `nod todo <list>` names. Finished todos are listed with --all, since `nod todo done`
// finishes todos.
const LISTS = ['inbox', 'next', 'waiting', 'someday', 'reference'] as const
// `nod today --days`: a weekly review looks two weeks ahead.
const MAX_DAYS = 31

// Who is changing a todo or a project. An explicit NOD_ACTOR wins (the web UI, a script); else a
// nod worker, a Claude session (by its session, so a change can be traced to it), or a person at
// a terminal.
export function actorFromEnv(env: Record<string, string | undefined> = process.env): string {
  if (env.NOD_ACTOR) return env.NOD_ACTOR
  if (env.NOD_TASK) return `worker:${env.NOD_TASK}`
  if (env.CLAUDECODE) {
    const session = sessionFromEnv(env)
    return session ? `claude:${session.slice(0, 8)}` : 'claude'
  }
  return 'human'
}

// The whole id of the Claude session acting, when actorFromEnv names one: `nod add` records it as
// the task's root session, and `--mine` picks the tasks it added. Null otherwise, an explicit
// NOD_ACTOR and a nod worker included.
export function sessionFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.NOD_ACTOR || env.NOD_TASK || !env.CLAUDECODE) return null
  return env.CLAUDE_CODE_SESSION_ID || null
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
      project: { type: 'string' },
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
      projectId: values.project === undefined ? null : todos.findProject(values.project).id,
    },
    actorFromEnv(),
  )
  console.log(created ? line(todos, todo) : `${line(todos, todo)}  (already captured)`)
}

// How long a session's name (`claude --name`) may be: it shows in the prompt box and the terminal
// title.
const SESSION_NAME_CHARS = 40

// A project session's name: the project's title, or `p<n>` and the start of it when that is long.
export function sessionTitle(p: Project): string {
  const name = p.title.length <= SESSION_NAME_CHARS ? p.title : `p${p.id} ${p.title}`
  return oneLine(name, SESSION_NAME_CHARS).trim()
}

// A transcript line of something said, by the person or by Claude.
const SAID = /"type":"(user|assistant)"/

// What `nod open` runs, and in which folder. The project's latest session is resumed in the folder
// it was opened in; a new one (`fresh`, or none yet) is recorded with `cwd` first and is the
// project's from then on. Either way the session has the project's tasks and decisions as its own
// (isMine). The account in `config` may keep no conversation of the latest: none of a session
// closed before its first message, and none of one kept in another account's folder, as accounts
// need not share their projects/ folder. Claude Code (2.1.310) then opens it with neither
// `--resume` (no conversation found) nor, once a transcript file of it is there, even an empty one
// or a title alone, `--session-id` (already in use). So a session with no transcript starts again
// under the same ID and name, and one whose transcript holds nothing said gives way to a new one.
// Every way, the session gets the project's name, resumed too (Claude Code 2.1.310 records it in
// the transcript): a /rename goes back to it, and a new title shows once the project is retitled.
export function openSession(
  todos: Todos,
  ref: string,
  fresh: boolean,
  cwd: string,
  config: string | null,
): { argv: string[]; cwd: string } {
  const project = todos.findProject(ref)
  // The session's name is for the person; Claude in it learns its project from this line alone.
  // Claude Code keeps a conversation's first system prompt on resume until it compacts, so a
  // resume passes it too. Its hooks tell nod where it takes the project's notices (inbox.ts).
  const told = [
    '--append-system-prompt',
    `nod open opened this session for project p${project.id} ${project.title}: nod add here puts work in that project, and the project's tasks and decisions are this session's.`,
    '--settings',
    openSettings(),
  ]
  const last = fresh ? null : todos.latestSession(project.id)
  const kept = last === null ? null : transcriptPath(config, last.sessionId)
  // ponytail: reads the whole transcript once per open; one of 69 MB took about 50 ms.
  const said = kept !== null && SAID.test(readFileSync(kept, 'utf8'))
  const again = last !== null && (said || kept === null) ? last : null
  if (again !== null && !existsSync(again.cwd)) {
    throw new Error(
      `p${project.id}'s session was opened in ${again.cwd}, which is gone; nod open p${project.id} --new opens a new one here`,
    )
  }
  const name = sessionTitle(project)
  if (again !== null && said) {
    return {
      argv: ['claude', '--resume', again.sessionId, '--name', name, ...told],
      cwd: again.cwd,
    }
  }
  if (last !== null) {
    const why =
      kept === null
        ? "closed before a word, or kept in another account's folder), so it starts again under that ID"
        : 'nothing said in it), which Claude Code opens neither to resume nor anew, so a new one opens here'
    console.error(
      `nod: this Claude account has no conversation of p${project.id}'s session ${last.sessionId} (${why}`,
    )
  }
  const session = again ?? todos.addSession(project.id, crypto.randomUUID(), cwd)
  const argv = ['claude', '--name', name, '--session-id', session.sessionId, ...told]
  return { argv, cwd: session.cwd }
}

// The project `nod add` puts its work in, by the Claude session it runs in (`session`). One nod
// open opened hands over its project's work only: the work goes in that project, and work of
// another is refused with where it goes instead. Any other session, and none, puts it where it is
// told; a Claude session also hears how to keep projects apart.
export function placeWork(
  todos: Todos,
  session: string | null,
  project: string | undefined,
  todo: Todo | null,
): number | null {
  const given = project === undefined ? null : todos.findProject(project).id
  const place = session === null ? null : todos.sessionPlace(session)
  if (place === null) {
    if (session !== null) {
      console.error(
        "hint: nod open <project> opens a Claude session for a project, which keeps each project's work apart",
      )
    }
    return given
  }
  const own = place.project
  const other = todo === null ? given : todo.projectId
  if (other === null || other === own.id) return own.id
  const p = todos.project(other)
  const mine = `this session is for p${own.id} ${own.title}`
  throw new Error(
    todo === null
      ? `${mine}; p${p.id} ${p.title}'s work goes in as a todo (nod in <what...> --project p${p.id}) or is handed over in its session (nod open p${p.id})`
      : `${mine}, and t${todo.id} is in p${p.id} ${p.title}: hand it over in that project's session (nod open p${p.id})`,
  )
}

export async function todoCommand(todos: Todos, home: string, args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (sub === 'check') {
    checkTodos(todos, home, rest)
  } else if (sub === 'set') {
    await setTodo(todos, home, rest)
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
      json: { type: 'boolean' },
    },
  })
  const [which, ...extra] = positionals
  const list = LISTS.find((s) => s === which)
  if (extra.length > 0 || (which !== undefined && list === undefined)) throw new Error(TODO_USAGE)
  if (values.all && list !== undefined) {
    throw new Error(`--all lists every status; leave out ${list}`)
  }
  const statuses = values.all ? [...TODO_STATUSES] : list !== undefined ? [list] : OPEN
  const projectId = values.project === undefined ? null : todos.findProject(values.project).id
  // A decision holds up a worker, so it comes before the other next actions. JSON lists only
  // todos, each with all its fields and links, for a Claude session to read.
  if (statuses.includes('next') && !values.json) {
    for (const d of todos.decisions()) {
      if (projectId === null || d.todo?.projectId === projectId) console.log(decisionLine(todos, d))
    }
  }
  const shown = todos.list({
    statuses,
    context: values.context ?? null,
    projectId,
    hideSomedayProjects: !values.all && values.project === undefined,
    day: values.all ? null : localDay(new Date()),
  })
  for (const t of shown) {
    const links = values.json ? todos.links(t.id).map((l) => l.url) : []
    console.log(values.json ? JSON.stringify({ ...t, links }) : line(todos, t))
  }
}

// `nod todo check`: whether the lists can be trusted. With --nudge, a line for Claude Code's
// SessionStart hook: once a day, never in a nod worker, and nothing when all is well.
function checkTodos(todos: Todos, home: string, args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { nudge: { type: 'boolean' }, json: { type: 'boolean' } },
  })
  const today = localDay(new Date())
  if (values.json) {
    console.log(JSON.stringify(todos.trust(today)))
    return
  }
  if (!values.nudge) {
    for (const l of trustLines(todos.trust(today))) console.log(l)
    return
  }
  if (process.env.NOD_TASK !== undefined) return
  const stamp = join(home, '.nudged')
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === today) return
  writeFileSync(stamp, today)
  const nudge = nudgeLine(todos.trust(today), today)
  if (nudge !== null) console.log(JSON.stringify({ systemMessage: `${nudge} → /gtd:today` }))
}

function trustLines(t: Trust): string[] {
  const listed = (refs: string[]) => (refs.length === 0 ? '' : `: ${refs.join(', ')}`)
  const todo = (x: Todo) => `t${x.id} ${oneLine(x.title, 40)}`
  const review =
    t.sinceReview === null ? 'none done yet' : `the last was ${t.sinceReview} day(s) ago`
  return [
    `inbox    ${t.inbox}${t.oldestInbox === null ? '' : `, the oldest captured ${t.oldestInbox}`}`,
    `overdue  ${t.overdue.length}${listed(t.overdue.map(todo))}`,
    `today    ${t.today.length}${listed(t.today.map(todo))}`,
    `stuck    ${t.stuck.length} active project(s) with no next action${listed(t.stuck.map((p) => `p${p.id} ${p.title}`))}`,
    `waiting  ${t.stale.length} on a person or a watch, unchanged for ${STALE_DAYS}+ days${listed(t.stale.map((x) => `${todo(x.todo)} (${x.todo.waitingOn ?? 'watched'}, ${x.days} days)`))}`,
    `review   weekly: ${review}`,
  ]
}

async function setTodo(todos: Todos, home: string, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      status: { type: 'string' },
      title: { type: 'string' },
      notes: { type: 'string' },
      'add-note': { type: 'string' },
      project: { type: 'string' },
      context: { type: 'string' },
      'waiting-on': { type: 'string' },
      link: { type: 'string', multiple: true },
      due: { type: 'string' },
      on: { type: 'string' },
      start: { type: 'string' },
      focus: { type: 'string' },
      repeat: { type: 'string' },
      watch: { type: 'string' },
      'back-to': { type: 'string' },
    },
  })
  const [ref, ...extra] = positionals
  if (ref === undefined || extra.length > 0) throw new Error(TODO_USAGE)
  const status = TODO_STATUSES.find((s) => s === values.status)
  if (values.status !== undefined && status === undefined) {
    throw new Error(`a todo status is one of ${TODO_STATUSES.join(', ')}`)
  }
  const { project } = values
  const id = parseRef(ref, 't')
  const added = values['add-note']
  if (added !== undefined && values.notes !== undefined) {
    throw new Error('--notes replaces the notes and --add-note adds a line to them; give one')
  }
  const watch = cleared(values.watch)
  const backToRef = cleared(values['back-to'])
  const backTo = typeof backToRef === 'string' ? todos.taskRef(backToRef) : backToRef
  if (Number.isNaN(backTo)) throw new Error(`--back-to takes a task number or t<n>: ${backToRef}`)
  const edit = {
    status,
    title: values.title,
    context: cleared(values.context),
    waitingOn: cleared(values['waiting-on']),
    due: cleared(values.due),
    scheduled: cleared(values.on),
    start: cleared(values.start),
    focus: cleared(values.focus),
    repeat: repeatOf(values.repeat),
    watch,
    backTo,
    projectId:
      project === undefined ? undefined : project === '' ? null : todos.findProject(project).id,
  }
  // A new watch runs once, which can take a while, so only for an edit that holds.
  if (typeof watch === 'string') todos.check(id, edit)
  const tried = typeof watch === 'string' ? { watch, ...(await tryWatch(watch, home)) } : null
  // A line added below the notes, so recording why leaves what was there alone. Read after the
  // watch ran, so nothing written meanwhile is lost.
  const notes =
    added === undefined
      ? cleared(values.notes)
      : [todos.get(id).notes, added].filter((x) => x !== null).join('\n')
  const todo = todos.set(id, { ...edit, notes }, actorFromEnv(), values.link ?? [])
  if (tried !== null) todos.recordCheck(id, tried.watch, tried.code, tried.output)
  console.log(line(todos, todo))
  if (tried === null) return
  console.log(`  ${checkText(todos.lastCheck(todo))}`)
  if (scheduleEnv(home) === null) console.log(`  ${SCHEDULE_OFF}`)
}

// When a watch last ran and how it ended, so the person sees it is alive and why it has not passed.
function checkText(check: WatchCheck | null): string {
  if (check === null) return checkedWhen(check)
  const said = check.output === '' ? '' : `: ${oneLine(check.output, 200)}`
  return `${checkedWhen(check)}, exit ${check.code}${said}`
}

const checkedWhen = (check: WatchCheck | null): string =>
  check === null ? 'not checked yet' : `checked ${localTime(new Date(check.at))}`

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
  if (t.watch !== null) console.log(`  watch ${t.watch}\n    ${checkText(todos.lastCheck(t))}`)
  if (t.backTo !== null) console.log(`  back to task #${t.backTo} once the watch passes`)
  for (const l of todos.links(id)) {
    console.log(`  link ${l.url}${l.title === null ? '' : ` (${l.title})`}`)
  }
  for (const { task, summary, links } of todos.tasks(id)) {
    const said = summary === null ? '' : `: ${oneLine(summary, 80)}`
    console.log(`  task #${task.id} ${task.status}${said}`)
    for (const url of links) console.log(`    link ${url}`)
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
  const open = {
    statuses: OPEN,
    context: null,
    projectId: p.id,
    hideSomedayProjects: false,
    day: null,
  }
  for (const t of todos.list(open)) console.log(`  ${line(todos, t)}`)
  printChanges(todos.projectChanges(p.id))
}

// `nod today [<day>] [--days <n>]`: what each day holds for certain, then what was picked for it.
// Days after the first show only when they hold something.
export async function todayCommand(todos: Todos, home: string, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { days: { type: 'string' } },
  })
  const [which, ...extra] = positionals
  if (extra.length > 0) throw new Error(TODO_USAGE)
  const count = values.days === undefined ? 1 : Number(values.days)
  if (!Number.isInteger(count) || count < 1 || count > MAX_DAYS) {
    throw new Error(`--days takes a number from 1 to ${MAX_DAYS}`)
  }
  const today = localDay(new Date())
  const first = which === undefined ? today : parseWhen(which, today, false)
  const read = await readEvents(home, first, count).then(
    (events) => ({ events }),
    (error: unknown) => ({ error: message(error) }),
  )
  // A calendar that could not be read says so, since no events would read as a free day.
  const unread =
    'error' in read
      ? `events: could not read the calendar, so none are shown: ${oneLine(read.error, 200)}`
      : read.events === null
        ? `events: no calendar; on macOS, build one with sh ${calendarBuild}`
        : null
  const calendar = 'error' in read || read.events === null ? [] : read.events
  for (let i = 0; i < count; i += 1) {
    const day = addDays(first, i)
    // An event that began before the first day is still going on it.
    const events = calendar.filter(
      (e) => dayOf(e.start) === day || (i === 0 && dayOf(e.start) < day),
    )
    // Overdue is as of the first day; on later days those todos are already listed.
    const groups = Object.entries(todos.day(day)).filter(
      ([group, ts]) => ts.length > 0 && (i === 0 || group !== 'overdue'),
    )
    if (i > 0 && events.length === 0 && groups.length === 0) continue
    const weekday = new Date(`${day}T12:00`).toLocaleDateString('en-US', { weekday: 'short' })
    console.log(`${day} ${weekday}`)
    if (i === 0 && unread !== null) {
      console.log(unread)
    } else if (events.length > 0) {
      console.log('events')
      for (const e of events) console.log(`  ${eventLine(e)}`)
    } else if (count === 1) {
      console.log('events: none')
    }
    if (groups.length === 0 && count === 1) console.log('todos: none for the day')
    for (const [name, ts] of groups) {
      console.log(name)
      for (const t of ts) console.log(`  ${line(todos, t)}`)
    }
  }
}

function eventLine(e: CalendarEvent): string {
  const when = e.allDay ? 'all day' : `${e.start.slice(11, 16)}-${e.end.slice(11, 16)}`
  const rest = [e.calendar, e.location ?? null, e.myStatus === 'pending' ? 'not answered' : null]
  return `${when.padEnd(11)} ${oneLine(e.title, 60)}  · ${rest.filter((x) => x !== null).join(' · ')}`
}

// `--repeat ''` stops it repeating.
function repeatOf(v: string | undefined): Repeat | null | undefined {
  if (v === undefined) return undefined
  if (v === '') return null
  const repeat = REPEATS.find((r) => r === v)
  if (repeat === undefined) throw new Error(`--repeat is one of ${REPEATS.join(', ')}`)
  return repeat
}

// An option given as an empty string clears the field; one not given leaves it alone.
const cleared = (v: string | undefined): string | null | undefined => (v === '' ? null : v)

function line(todos: Todos, t: Todo): string {
  const rest = tags(todos, t)
  const after = rest.length > 0 ? `  · ${rest.join(' · ')}` : ''
  return `t${String(t.id).padEnd(4)} ${t.status.padEnd(9)} ${oneLine(t.title, 80)}${after}`
}

// `#12 decide`, the decision `nod 12 <answer>` answers. It has no context: it can be answered
// anywhere.
function decisionLine(todos: Todos, { decision, task, todo }: TodoDecision): string {
  const project = todo === null || todo.projectId === null ? null : todos.project(todo.projectId)
  const rest = [
    decision.reason,
    `task #${task.id}`,
    project === null ? null : `p${project.id} ${project.title}`,
    `since ${localTime(new Date(decision.createdAt))}`,
  ].filter((x) => x !== null)
  const title = oneLine(todo?.title ?? task.brief, 80)
  return `#${String(decision.id).padEnd(4)} ${'decide'.padEnd(9)} ${title}  · ${rest.join(' · ')}`
}

function tags(todos: Todos, t: Todo): string[] {
  const project = t.projectId === null ? null : todos.project(t.projectId)
  const finished = t.status === 'done' || t.status === 'dropped'
  const on = t.status === 'waiting' ? todos.waitingFor(t) : null
  return [
    t.context,
    project === null ? null : `p${project.id} ${project.title}`,
    on === null ? null : `waiting on ${on}`,
    t.watch === null ? null : `watched, ${checkedWhen(todos.lastCheck(t))}`,
    t.scheduled === null ? null : `scheduled ${t.scheduled}`,
    t.due === null ? null : `due ${t.due}`,
    t.start === null ? null : `starts ${t.start}`,
    t.repeat === null ? null : `repeats ${t.repeat}`,
    t.focus === null ? null : `focus ${t.focus}`,
    t.status === 'inbox' || t.status === 'waiting'
      ? `since ${localTime(new Date(t.statusAt))}`
      : null,
    finished ? `on ${localTime(new Date(t.statusAt))}` : null,
  ].filter((x) => x !== null)
}

const projectLine = (p: Project): string => {
  const outcome = p.outcome === null ? '' : ` — ${oneLine(p.outcome, 60)}`
  return `p${String(p.id).padEnd(4)} ${p.status.padEnd(8)} ${p.title}${outcome}`
}

function printChanges(changes: Change[]): void {
  console.log('  changes')
  for (const c of changes) {
    console.log(`    ${localTime(new Date(c.at))}  ${c.actor}  ${changeText(c)}`)
  }
}
