// What the pages show, read from the ledger, and the messages they send to workers. Server only:
// the routes reach it through server functions, so the ledger and tmux never ship to the browser.
import {
  type Attempt,
  type Decision,
  Ledger,
  nodHome,
  type Retro,
  type RuleNow,
  type Stats,
  type Task,
  type Trigger,
} from '../../src/ledger'
import { Terminals } from '../../src/tmux'
import { type Found, type Project, type Todo, Todos } from '../../src/todos'
import { reopenCommand, taskNote, taskStatus } from '../../src/view'
import { answer, sessionName, tell } from '../../src/worker'

export const home = nodHome()
// One connection for the server's life, shared with the todo pages (todos.server.ts); WAL lets nod
// write while this reads.
export const ledger = new Ledger(home)
const terminals = Terminals.of(home)
// Changes made here record this actor. The server may run inside a Claude session, where the
// environment would make them claude's.
export const ACTOR = 'human:ui'

export type TaskRow = {
  id: number
  status: string
  turns: number
  // What the task is: its todo's title, else the brief's first line. The note is how it went last.
  title: string
  note: string
  issue: string | null
  todoId: number | null
  retroId: number | null
  projectId: number | null
  links: string[]
}

// Where a task sits in the person's lists: the todo it does and that todo's project.
export type Place = { todo: Todo | null; project: Project | null }

export type OpenDecision = Decision & {
  brief: string
  issue: string | null
  todoId: number | null
  retroId: number | null
}

// The start of a list that only grows, and how long the whole list is.
export type Shown<T> = { items: T[]; total: number }

// The sidebar's collected tasks; the rest are on the Done page.
const SIDE_COLLECTED = 20

export type Overview = {
  decisions: OpenDecision[]
  // Tasks by the project of the todo they do. What needs the person comes first, in a group and
  // between groups; the tasks in no project come last.
  groups: { project: Project | null; tasks: TaskRow[] }[]
  // What gc collected, which `nod ls` lists only with --all.
  collected: Shown<TaskRow>
  triggers: Trigger[]
  stats: Stats
  // For the sidebar's link to the todos.
  inbox: number
}

export type Detail = {
  task: Task
  status: string
  links: string[]
  after: { id: number; status: string }[]
  // The prompt is left out, as in `nod show`.
  attempts: Omit<Attempt, 'prompt'>[]
  decisions: Decision[]
  report: string | null
  place: Place
  // With the rule it added as it stands now.
  retro: (Retro & { rules: RuleNow[] }) | null
  // The worker's terminal right now, while its session is alive.
  screen: string | null
  // The project session whose task it is now (Todos.rootPlace), with the command that goes back
  // into it, and the session that added the task when that was another; null when it is no
  // session nod open opened.
  root: { project: Project; command: string; addedFrom: string | null } | null
}

export function overview(): Overview {
  const todos = new Todos(ledger)
  const tasks = ledger.list()
  const rows = tasks.filter((t) => t.collectedAt === null).map((t) => row(todos, t))
  return {
    decisions: ledger.openDecisions().map((d) => {
      const t = ledger.get(d.taskId)
      return { ...d, brief: t.brief, issue: t.issue, todoId: t.todoId, retroId: t.retroId }
    }),
    groups: [...Map.groupBy(rows, (t) => t.projectId)]
      .map(([id, ts]) => ({
        project: id === null ? null : todos.project(id),
        tasks: ts.sort((a, b) => rank(a) - rank(b)),
      }))
      .sort(
        (a, b) =>
          Math.min(...a.tasks.map(rank)) - Math.min(...b.tasks.map(rank)) ||
          Number(a.project === null) - Number(b.project === null) ||
          (a.project?.id ?? 0) - (b.project?.id ?? 0),
      ),
    collected: latestCollected(todos, tasks, SIDE_COLLECTED),
    triggers: ledger.triggers(),
    stats: ledger.stats(),
    inbox: todos.list({
      statuses: ['inbox'],
      context: null,
      projectId: null,
      hideSomedayProjects: false,
      day: null,
    }).length,
  }
}

// The sidebar's search, as `nod search` finds.
export const find = (ref: string): Found[] =>
  new Todos(ledger).find(ref, (t) => taskStatus(t, terminals))

export const collected = (limit: number): Shown<TaskRow> =>
  latestCollected(new Todos(ledger), ledger.list(), limit)

// The latest collected first; a row is made only for those shown.
function latestCollected(todos: Todos, tasks: Task[], limit: number): Shown<TaskRow> {
  const all = tasks
    .filter((t) => t.collectedAt !== null)
    .sort((a, b) => (b.collectedAt ?? '').localeCompare(a.collectedAt ?? '') || b.id - a.id)
  return { items: all.slice(0, limit).map((t) => row(todos, t)), total: all.length }
}

// null for a number no task has, as an old link may name: the page says it is not there.
export function detail(id: number): Detail | null {
  const { task } = ledger.numbered(id)
  if (task === null) return null
  const attempts = ledger.attempts(id)
  const name = sessionName(id)
  const todos = new Todos(ledger)
  const root = todos.rootPlace(task)
  const added = task.rootSession === root?.session.sessionId ? null : task.rootSession
  return {
    task,
    status: taskStatus(task, terminals),
    links: ledger.links(id),
    after: ledger.after(id).map((a) => ({ id: a.id, status: a.status })),
    attempts: attempts.map(({ prompt: _, ...a }) => a),
    decisions: ledger.decisions(id),
    report: attempts.filter((a) => a.report).at(-1)?.report ?? null,
    place: place(todos, task),
    retro: task.retroId === null ? null : retroOf(task.retroId),
    screen: terminals.alive(name) ? terminals.screen(name).trimEnd() : null,
    root:
      root === null
        ? null
        : { project: root.project, command: reopenCommand(root), addedFrom: added },
  }
}

function retroOf(id: number): Detail['retro'] {
  return { ...ledger.retro(id), rules: ledger.rulesNow().filter((r) => r.retroId === id) }
}

// A rule on the Settings page, with the task its retrospective ran in; null for one the person
// wrote.
export type RuleRow = RuleNow & { retroTaskId: number | null }

// Every rule, on or off.
export function rules(): RuleRow[] {
  const retroTask = new Map(ledger.list().map((t) => [t.retroId, t.id]))
  return ledger.rulesNow().map((r) => ({
    ...r,
    retroTaskId: r.retroId === null ? null : (retroTask.get(r.retroId) ?? null),
  }))
}

export type Message = { taskId: number; decisionId: number | null; text: string }

// What `nod tell` and `nod <decision> <answer>` do. While a decision is open the worker waits on
// it, so a message answers it; a tell then could land on a permission dialog, where Enter means
// yes.
export async function send(m: Message): Promise<void> {
  // A message reaches a worker in auto mode, so another site open in the same browser must not
  // send one. TanStack Start already refuses that: with no src/start.ts it puts its CSRF middleware
  // (Sec-Fetch-Site, else Origin, must be this page) in front of every server function. A
  // src/start.ts must keep createCsrfMiddleware in its requestMiddleware.
  const task = ledger.get(m.taskId)
  const open = ledger.decisions(task.id).find((d) => d.answer === null)
  if (m.decisionId === null) {
    if (open !== undefined) throw new Error(`answer decision #${open.id} first`)
    await tell(ledger, home, task.id, m.text)
    return
  }
  if (open?.id !== m.decisionId)
    throw new Error(`decision #${m.decisionId} is not open on #${task.id}`)
  await answer(ledger, home, m.decisionId, m.text, ACTOR)
}

// Decisions first, then tasks that went wrong, then those at work.
const RANK: Record<string, number> = {
  needs_decision: 0,
  error: 1,
  failed: 1,
  'session ended': 1,
  running: 2,
  queued: 3,
  succeeded: 4,
}
const rank = (t: TaskRow): number => RANK[t.status] ?? 5

// A retrospective does no todo of its own; it sits in the project of the task it looks back on.
function place(todos: Todos, t: Task): Place {
  const todo = t.todoId === null ? null : todos.get(t.todoId)
  if (todo === null) {
    return {
      todo: null,
      project:
        t.retroId === null
          ? null
          : place(todos, ledger.get(ledger.retro(t.retroId).ofTaskId)).project,
    }
  }
  return { todo, project: todo.projectId === null ? null : todos.project(todo.projectId) }
}

function row(todos: Todos, t: Task): TaskRow {
  const { todo, project } = place(todos, t)
  return {
    id: t.id,
    status: taskStatus(t, terminals),
    turns: ledger.attempts(t.id).length,
    title: todo?.title ?? t.brief.replace(/\n[\s\S]*/, ''),
    note: taskNote(ledger, t),
    issue: t.issue,
    todoId: todo?.id ?? null,
    retroId: t.retroId,
    projectId: project?.id ?? null,
    links: ledger.links(t.id),
  }
}
