// What the pages show, read from the ledger, and the messages they send to workers. Server only:
// the routes reach it through server functions, so the ledger and tmux never ship to the browser.
import {
  type Attempt,
  type Decision,
  Ledger,
  nodHome,
  type Stats,
  type Task,
  type Trigger,
} from '../../src/ledger'
import { Terminals } from '../../src/tmux'
import { type Project, type Todo, Todos } from '../../src/todos'
import { taskNote, taskStatus } from '../../src/view'
import { answer, sessionName, tell } from '../../src/worker'

export const home = nodHome()
// One connection for the server's life, shared with the todo pages (todos.server.ts); WAL lets nod
// write while this reads.
export const ledger = new Ledger(home)
const terminals = Terminals.of(home)

export type TaskRow = {
  id: number
  status: string
  turns: number
  // What the task is: its todo's title, else the brief's first line. The note is how it went last.
  title: string
  note: string
  issue: string | null
  todoId: number | null
  projectId: number | null
  links: string[]
}

// Where a task sits in the person's lists: the todo it does and that todo's project.
export type Place = { todo: Todo | null; project: Project | null }

export type OpenDecision = Decision & { brief: string; issue: string | null; todoId: number | null }

export type Overview = {
  decisions: OpenDecision[]
  // Tasks by the project of the todo they do. What needs the person comes first, in a group and
  // between groups; the tasks in no project come last.
  groups: { project: Project | null; tasks: TaskRow[] }[]
  // What gc collected, which `nod ls` lists only with --all.
  collected: TaskRow[]
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
  // The worker's terminal right now, while its session is alive.
  screen: string | null
}

export function overview(): Overview {
  const todos = new Todos(ledger)
  const tasks = ledger.list()
  const rows = tasks.filter((t) => t.collectedAt === null).map((t) => row(todos, t))
  return {
    decisions: ledger.openDecisions().map((d) => {
      const t = ledger.get(d.taskId)
      return { ...d, brief: t.brief, issue: t.issue, todoId: t.todoId }
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
    collected: tasks.filter((t) => t.collectedAt !== null).map((t) => row(todos, t)),
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

export function detail(id: number): Detail {
  const task = ledger.get(id)
  const attempts = ledger.attempts(id)
  const name = sessionName(id)
  return {
    task,
    status: taskStatus(task, terminals),
    links: ledger.links(id),
    after: ledger.after(id).map((a) => ({ id: a.id, status: a.status })),
    attempts: attempts.map(({ prompt: _, ...a }) => a),
    decisions: ledger.decisions(id),
    report: attempts.filter((a) => a.report).at(-1)?.report ?? null,
    place: place(new Todos(ledger), task),
    screen: terminals.alive(name) ? terminals.screen(name).trimEnd() : null,
  }
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
  await answer(ledger, home, m.decisionId, m.text)
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
      project: t.retroOf === null ? null : place(todos, ledger.get(t.retroOf)).project,
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
    projectId: project?.id ?? null,
    links: ledger.links(t.id),
  }
}
