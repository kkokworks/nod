// Brings the todos and projects of Mindwtr, the GTD app nod replaces, into nod's ledger once,
// keeping their times. Reads what Mindwtr's MCP tools list (mindwtr_list_tasks with status all,
// and mindwtr_list_projects) as JSON files, and writes into $NOD_HOME's ledger, which must have no
// todos or projects yet. Then it checks each status's count against Mindwtr's.
// Usage: bun scripts/import-mindwtr.ts <tasks.json> <projects.json>
import { z } from 'zod'
import { loadConfig } from '../skills/gtd/sources/config'
import { localDay, REPEATS } from '../src/days'
import { Ledger } from '../src/ledger'
import {
  PROJECT_STATUSES,
  type Project,
  type ProjectStatus,
  TODO_STATUSES,
  type Todo,
  type TodoLink,
  type TodoStatus,
  Todos,
} from '../src/todos'
import { REVIEW_SOURCE } from '../src/trust'

const ACTOR = 'import'
// The weekly review the gtd skill set up; its series becomes nod's (trust.ts).
const REVIEW_TITLE = '주간 리뷰하기'
// A work tool's key wins over the others when a todo links to several.
const TOOLS = ['plane', 'forgejo', 'github', 'slack'] as const

const Task = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived']),
  description: z.string().optional(),
  projectId: z.string().optional(),
  contexts: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  assignedTo: z.string().optional(),
  dueDate: z.string().optional(),
  startTime: z.string().optional(),
  recurrence: z.object({ rule: z.string() }).optional(),
  isFocusedToday: z.boolean().optional(),
  timeEstimate: z.string().optional(),
  checklist: z.array(z.object({ title: z.string(), isCompleted: z.boolean() })).optional(),
  attachments: z
    .array(z.object({ kind: z.string(), uri: z.string(), title: z.string().optional() }))
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  cancelledAt: z.string().optional(),
  archivedAt: z.string().optional(),
  deletedAt: z.string().optional(),
})
type Task = z.infer<typeof Task>
const MProject = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['active', 'someday', 'archived']),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().optional(),
  deletedAt: z.string().optional(),
})
type MProject = z.infer<typeof MProject>

export type Tools = { planeUrl: string | null; forgejoOrg: string | null }
type NewTodo = Omit<Todo, 'id' | 'projectId'> & { project: string | null }
export type Imported = {
  projects: { key: string; row: Omit<Project, 'id'>; at: string }[]
  // `nodTask`: the nod task it was delegated to, from a first line `nod #<task>`.
  todos: { row: NewTodo; links: TodoLink[]; at: string; nodTask: number | null }[]
  // Mindwtr's own count for each nod status, by the mapping below.
  expected: Record<TodoStatus, number>
}

// A day, or a time, as it was on this computer; Mindwtr keeps a day alone as `YYYY-MM-DD`.
const day = (iso: string): string => (iso.length === 10 ? iso : localDay(new Date(iso)))
const when = (iso: string): string =>
  iso.length === 10 ? iso : `${day(iso)} ${new Date(iso).toLocaleTimeString('sv-SE').slice(0, 5)}`

// Mindwtr's archive holds both done and cancelled todos; deleted ones are not brought.
function statusOf(t: Task): { status: TodoStatus; at: string } {
  if (t.status === 'archived') {
    return t.cancelledAt !== undefined
      ? { status: 'dropped', at: t.cancelledAt }
      : { status: 'done', at: t.completedAt ?? t.archivedAt ?? t.updatedAt }
  }
  if (t.status === 'done') return { status: 'done', at: t.completedAt ?? t.updatedAt }
  if (t.status === 'inbox') return { status: 'inbox', at: t.createdAt }
  return { status: t.status, at: t.updatedAt }
}

// The fields nod has no column for go below the notes. A checklist item that mirrors a nod decision
// (`결정 #N`) is left out: the decision is in the ledger.
function notesOf(t: Task, waitingOn: string | null): string | null {
  const checks = (t.checklist ?? [])
    .filter((c) => !/^결정 #\d+/.test(c.title))
    .map((c) => `- [${c.isCompleted ? 'x' : ' '}] ${c.title}`)
  const lines = [
    t.description?.trim() || null,
    checks.length === 0 ? null : ['체크리스트:', ...checks].join('\n'),
    t.tags !== undefined && t.tags.length > 0 ? `태그: ${t.tags.join(', ')}` : null,
    t.timeEstimate === undefined ? null : `예상 시간: ${t.timeEstimate}`,
    t.assignedTo === undefined || t.assignedTo === waitingOn || t.assignedTo === 'nod'
      ? null
      : `맡은 사람: ${t.assignedTo}`,
  ].filter((x) => x !== null)
  return lines.length === 0 ? null : lines.join('\n\n')
}

// The work tool and key a scan of that tool gives the same item (skills/nod/sources), so the first
// scan after the move does not capture it again.
function toolKey(url: string, tools: Tools): { source: string; key: string } | null {
  if (tools.planeUrl !== null && url.startsWith(tools.planeUrl)) {
    const key = /\/browse\/([A-Z][A-Z0-9]*-\d+)\/?$/.exec(url)?.[1]
    if (key !== undefined) return { source: 'plane', key }
  }
  if (tools.forgejoOrg !== null && new RegExp(`/${tools.forgejoOrg}/[^/]+/pulls/\\d+$`).test(url)) {
    return { source: 'forgejo', key: url }
  }
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) {
    return { source: 'github', key: url }
  }
  if (/^https:\/\/[^/]+\.slack\.com\/archives\//.test(url)) return { source: 'slack', key: url }
  return null
}

export function mapMindwtr(rawTasks: unknown, rawProjects: unknown, tools: Tools): Imported {
  const tasks = z
    .array(Task)
    .parse(rawTasks)
    .filter((t) => t.deletedAt === undefined)
  const projects = z
    .array(MProject)
    .parse(rawProjects)
    .filter((p) => p.deletedAt === undefined)
  const keyOf = (t: Task) =>
    TOOLS.flatMap((tool) =>
      (t.attachments ?? []).flatMap((a) => {
        const k = toolKey(a.uri, tools)
        return k?.source === tool ? [k] : []
      }),
    )[0] ?? null
  // One todo per channel key: the open one, or else the one that moved last.
  const open = (t: Task) => ['inbox', 'next', 'waiting'].includes(t.status)
  const owner = new Map<string, Task>()
  for (const t of tasks) {
    const k = keyOf(t)
    if (k === null) continue
    const id = `${k.source}\t${k.key}`
    const held = owner.get(id)
    const wins =
      held === undefined ||
      (open(t) && !open(held)) ||
      (open(t) === open(held) && t.updatedAt > held.updatedAt)
    if (wins) owner.set(id, t)
  }
  const sourceOf = (t: Task): { source: string; sourceKey: string } => {
    if (t.title === REVIEW_TITLE) return { source: REVIEW_SOURCE, sourceKey: t.id }
    const k = keyOf(t)
    return k !== null && owner.get(`${k.source}\t${k.key}`) === t
      ? { source: k.source, sourceKey: k.key }
      : { source: 'mindwtr', sourceKey: t.id }
  }

  const expected: Record<TodoStatus, number> = {
    inbox: 0,
    next: 0,
    waiting: 0,
    someday: 0,
    reference: 0,
    done: 0,
    dropped: 0,
  }
  const todos = tasks.map((t) => {
    const { status, at } = statusOf(t)
    expected[status] += 1
    const waitingOn =
      status === 'waiting' && t.assignedTo !== undefined && t.assignedTo !== 'nod'
        ? t.assignedTo
        : null
    const context = t.contexts?.[0] ?? null
    const repeat = t.recurrence === undefined ? null : REPEATS.find((r) => r === t.recurrence?.rule)
    if (repeat === undefined)
      throw new Error(`${t.id} repeats ${t.recurrence?.rule}, not one of ${REPEATS}`)
    const nodTask = /^nod #(\d+)/.exec(t.description ?? '')?.[1]
    return {
      row: {
        title: t.title,
        notes: notesOf(t, waitingOn),
        status,
        project: t.projectId ?? null,
        context: context === null || context.startsWith('@') ? context : `@${context}`,
        waitingOn,
        due: t.dueDate === undefined ? null : when(t.dueDate),
        scheduled: null,
        start: t.startTime === undefined ? null : day(t.startTime),
        repeat,
        focus: t.isFocusedToday === true ? day(t.updatedAt) : null,
        watch: null,
        backTo: null,
        ...sourceOf(t),
        createdAt: t.createdAt,
        statusAt: at,
      },
      links: (t.attachments ?? [])
        .filter((a) => a.kind === 'link')
        .map((a) => ({ url: a.uri, title: a.title ?? null })),
      at: t.updatedAt,
      nodTask: nodTask === undefined ? null : Number(nodTask),
    }
  })

  // An archived project is dropped when everything in it was, and done otherwise.
  const statusOfProject = (p: MProject): ProjectStatus => {
    if (p.status !== 'archived') return p.status
    const inside = todos.filter((t) => t.row.project === p.id)
    return inside.length > 0 && inside.every((t) => t.row.status === 'dropped') ? 'dropped' : 'done'
  }
  return {
    projects: projects.map((p) => ({
      key: p.id,
      row: {
        title: p.title,
        outcome: null,
        status: statusOfProject(p),
        createdAt: p.createdAt,
        statusAt: p.archivedAt ?? p.updatedAt,
      },
      at: p.updatedAt,
    })),
    todos,
    expected,
  }
}

// What `nod #<task>` lines named that could not be linked: tasks the ledger does not have, and
// todos whose task another todo got. A task does one todo; when several named it (one task done
// for two issues), the open one gets it, or else the one that moved last.
export type Unlinked = { missing: number[]; shared: { task: number; todos: number[] }[] }

// All or nothing, into a ledger with no todos or projects, so a second run cannot bring them twice.
export function apply(ledger: Ledger, data: Imported): Unlinked {
  const todos = new Todos(ledger)
  const tasks = new Set(ledger.list().map((t) => t.id))
  return ledger.db.transaction(() => {
    const every = { context: null, projectId: null, hideSomedayProjects: false, day: null }
    if (
      todos.list({ statuses: [...TODO_STATUSES], ...every }).length > 0 ||
      todos.projects([...PROJECT_STATUSES]).length > 0
    ) {
      throw new Error('the ledger already has todos or projects; import into an empty one')
    }
    const ids = new Map(data.projects.map((p) => [p.key, todos.importProject(p.row, ACTOR, p.at)]))
    const named = new Map<number, { id: number; open: boolean; at: string }[]>()
    for (const { row, links, at, nodTask } of data.todos) {
      const { project, ...rest } = row
      const projectId = project === null ? null : ids.get(project)
      if (projectId === undefined) throw new Error(`no project ${project} for ${row.title}`)
      const id = todos.importTodo({ ...rest, projectId }, links, ACTOR, at)
      if (nodTask === null) continue
      const open = ['inbox', 'next', 'waiting'].includes(row.status)
      named.set(nodTask, [...(named.get(nodTask) ?? []), { id, open, at }])
    }
    const unlinked: Unlinked = { missing: [], shared: [] }
    for (const [task, candidates] of named) {
      if (!tasks.has(task)) {
        unlinked.missing.push(task)
        continue
      }
      const [first, ...rest] = candidates.toSorted(
        (a, b) => Number(b.open) - Number(a.open) || b.at.localeCompare(a.at),
      )
      if (first === undefined) continue
      ledger.linkTodoTask(task, first.id)
      if (rest.length > 0) unlinked.shared.push({ task, todos: rest.map((c) => c.id) })
    }
    return unlinked
  })()
}

if (import.meta.main) {
  const [tasksFile, projectsFile] = Bun.argv.slice(2)
  if (tasksFile === undefined || projectsFile === undefined) {
    throw new Error('usage: bun scripts/import-mindwtr.ts <tasks.json> <projects.json>')
  }
  const config = await loadConfig()
  const data = mapMindwtr(await Bun.file(tasksFile).json(), await Bun.file(projectsFile).json(), {
    planeUrl: config.plane?.url ?? null,
    forgejoOrg: config.forgejo?.org ?? null,
  })
  const ledger = new Ledger()
  const unlinked = apply(ledger, data)
  const todos = new Todos(ledger)
  const every = { context: null, projectId: null, hideSomedayProjects: false, day: null }
  let same = true
  console.log('status     mindwtr  nod')
  for (const s of TODO_STATUSES) {
    const got = todos.list({ statuses: [s], ...every }).length
    same &&= got === data.expected[s]
    console.log(`${s.padEnd(10)} ${String(data.expected[s]).padStart(7)}  ${got}`)
  }
  const projects = todos.projects([...PROJECT_STATUSES])
  console.log(`projects   ${String(data.projects.length).padStart(7)}  ${projects.length}`)
  same &&= projects.length === data.projects.length
  if (unlinked.missing.length > 0) {
    console.log(`nod tasks not in the ledger: ${unlinked.missing.map((n) => `#${n}`).join(', ')}`)
  }
  for (const { task, todos: ts } of unlinked.shared) {
    console.log(`task #${task} does another todo, so not ${ts.map((t) => `t${t}`).join(', ')}`)
  }
  if (!same) throw new Error('the counts differ')
}
