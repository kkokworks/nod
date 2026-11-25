import { z } from 'zod'
import { dialogOn, isUnseen } from './dialog'
import { type Decision, type Ledger, type Task, YES_OR_NO } from './ledger'
import { sessionName } from './place'
import { message } from './proc'
import type { Terminals } from './tmux'
import { firstLineOf, parseRef, type Session, Todos } from './todos'
import { clean, taskLabel } from './view'
import { answer } from './worker'

// nod's MCP server (`nod mcp`, JSON-RPC lines on stdio), which nod open gives the project,
// orchestrator and helper sessions it opens (openMcp in settings.ts). Its one tool, decide, shows the
// person a decision that takes yes or no as Claude Code's own dialog (elicitation, form mode), and
// what they pick goes to nod as theirs, not through the model, which must not answer for them:
// Accept is yes, Decline no, Esc leaves it open. nod words the dialog from the ledger, never from
// what the model passes. Measured on 2.1.332 in auto mode: the client says elicitation.form as it
// starts, the dialog shows with Accept picked first, and its answer comes as {"action":"accept"}.

// Where the person reads a decision no dialog shows whole: its task's page in the web UI
// (ui/package.json's port).
const UI = 'http://127.0.0.1:4800/tasks'
// The most a dialog's text takes, in rows of a terminal 80 columns wide; a longer one is read on the
// UI, so the person sees all of what they say yes to.
// ponytail: not measured how Claude Code draws a tall dialog; a narrower terminal wraps more.
const COLUMNS = 80
const ROWS = 20
// An accept sooner than `soonMs` after the dialog went out is a key pressed before it showed, or a
// hook's (Elicitation), and is not used; nothing waits longer than `maxMs` on a person who is away.
// In the open so a test can change them.
export const WAIT = { soonMs: 1000, maxMs: 600_000 }
const PROTOCOLS = ['2025-06-18', '2025-11-25']

// What No does, as the dialog says it (answer in worker.ts).
const NO: Record<string, string> = {
  permission: 'denies the command',
  trust: 'ends the task',
  rule: 'ends the retrospective with no rule added',
  land: 'stops landing the task; its work stands',
}

const DESCRIPTION =
  "Shows the person a nod decision that takes yes or no (permission, trust, rule, land) as a dialog, worded by nod from its ledger, and gives nod what they pick: Accept is yes, Decline no, Esc leaves it open. Call it when a nod notice's next: line names it, instead of asking the person yourself; never answer such a decision for them. With no decision, it shows each open one of this session's in turn. It waits on the person up to 10 minutes, then leaves the decision open."

const Message = z.object({
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
})
const Elicited = z.object({ action: z.enum(['accept', 'decline', 'cancel']) })
const Called = z.object({
  name: z.string(),
  arguments: z.object({ decision: z.string().optional() }).optional(),
})

type Reply = 'accept' | 'decline' | 'cancel' | { failed: string }
// What became of one decision; `stop`: show no more in this call.
type Outcome = { line: string; refused?: boolean; stop?: boolean }

// Handles one line from the client, and returns once its answer is written. A tool call waits on
// the client's answer to its dialog, a later line, so lines must not wait on each other (cli.ts).
// `session`: the Claude session nod open ran the server for.
export function mcpServer(o: {
  ledger: Ledger
  home: string
  terminals: Terminals
  session: string | null
  env: Record<string, string | undefined>
  write: (line: string) => void
  now?: () => number
}): (line: string) => Promise<void> {
  const now = o.now ?? Date.now
  const send = (m: object): void => o.write(JSON.stringify({ jsonrpc: '2.0', ...m }))
  const todos = new Todos(o.ledger)
  let elicits = false
  let asked = 0
  const waiting = new Map<string, (r: Reply) => void>()

  // Shows `text` as a dialog and waits up to `ms` for the person; one given up on is withdrawn.
  const elicit = (text: string, ms: number): Promise<Reply> => {
    const id = `nod-${++asked}`
    const { promise, resolve } = Promise.withResolvers<Reply>()
    const timer = setTimeout(() => {
      waiting.delete(id)
      send({ method: 'notifications/cancelled', params: { requestId: id, reason: 'nod waited' } })
      resolve({ failed: 'no answer came in time' })
    }, ms)
    waiting.set(id, (r) => {
      clearTimeout(timer)
      waiting.delete(id)
      resolve(r)
    })
    const schema = { type: 'object', properties: {} }
    send({
      id,
      method: 'elicitation/create',
      params: { mode: 'form', message: text, requestedSchema: schema },
    })
    return promise
  }

  // A permission decision's dialog is gone once its worker's terminal shows none: Claude Code blocks
  // a request left unanswered by itself (2.1.332 counts down some 2 minutes in auto mode), or a
  // person answered it there. Then Enter would go to what shows instead, and Escape stop the turn.
  const gone = (d: Decision): string | null => {
    if (d.reason !== 'permission') return null
    let screen = ''
    try {
      screen = o.terminals.screen(sessionName(d.taskId))
    } catch {}
    if (dialogOn(screen) !== null) return null
    return `n${d.taskId}'s terminal shows no dialog nod can read now: Claude Code blocks a request left unanswered by itself (in some 2 minutes, in auto mode), or it was answered there. nod did not answer d${d.id}, which stays open; nod peek n${d.taskId} shows the terminal`
  }

  const one = async (me: Session, d: Decision, until: number): Promise<Outcome> => {
    const task = o.ledger.get(d.taskId)
    const page = `${UI}/${task.id}`
    if (!mayShow(todos, me, task)) {
      return { line: `d${d.id} is of task n${task.id}, not this session's work`, refused: true }
    }
    if (!YES_OR_NO.includes(d.reason)) {
      const line = `d${d.id} is a ${d.reason} decision, answered in the person's words: tell the person; nod d${d.id} <their answer> answers it`
      return { line, refused: true }
    }
    if (d.answer !== null) return { line: `d${d.id} is closed already: ${d.answer}` }
    if (isUnseen(d)) {
      return {
        line: `d${d.id} does not say which command it allows: the person looks at the worker's terminal (nod attach n${task.id}) and answers on ${page}`,
      }
    }
    const text = dialogText(todos, d, task)
    if (rows(text) > ROWS) {
      return {
        line: `d${d.id} is too long for a dialog: the person reads and answers it on ${page}`,
      }
    }
    if (!elicits) {
      return {
        line: `this Claude Code shows nod no dialog (it said no elicitation): the person answers d${d.id} on ${page}`,
      }
    }
    const before = gone(d)
    if (before !== null) return { line: before }
    const shown = now()
    const reply = await elicit(text, until - shown)
    if (typeof reply === 'object') {
      return { line: `d${d.id} stays open: ${reply.failed}`, stop: true }
    }
    if (reply === 'cancel') {
      return { line: `the person closed the dialog of d${d.id}, which stays open`, stop: true }
    }
    if (reply === 'accept' && now() - shown < WAIT.soonMs) {
      return {
        line: `d${d.id} was accepted within a second of showing, sooner than a person reads it (a key pressed before it showed, or a hook): nod did not use it, and it stays open`,
      }
    }
    const said = reply === 'accept' ? 'yes' : 'no'
    const elsewhere = (was: string): Outcome => ({
      line: `d${d.id} was answered elsewhere meanwhile (${was}): nod did nothing with this ${said}`,
    })
    const was = o.ledger.decision(d.id).answer
    if (was !== null) return elsewhere(was)
    const after = gone(d)
    if (after !== null) return { line: after }
    try {
      // The person's answer: the model's session is only where they gave it, which hears it here.
      const took = await answer(o.ledger, o.home, o.terminals, d.id, said, 'human', me.sessionKey)
      const done = took
        ? `sent to task n${task.id}`
        : `task n${task.id} had ended, so it only closed`
      return { line: `d${d.id} ${d.reason}: the person answered ${said}; ${done}` }
    } catch (error) {
      const closed = o.ledger.decision(d.id).answer
      if (/is already answered$/.test(message(error)) && closed !== null) return elsewhere(closed)
      const stands = closed === null ? 'it stays open' : `it is closed (${closed})`
      return { line: `d${d.id}: ${message(error)}; ${stands}` }
    }
  }

  // The tool call: one decision, or each open one of the session's in turn.
  const decide = async (ref: string | undefined): Promise<Outcome> => {
    if (o.env.NOD_TASK !== undefined || o.env.SANDBOX_RUNTIME === '1') {
      return { line: 'nod shows no decision from a nod worker or a sandbox', refused: true }
    }
    const me = o.session === null ? null : todos.session(o.session)
    if (me === null) {
      return {
        line: 'this session is not one nod open opened: nod shows it no decision',
        refused: true,
      }
    }
    const until = now() + WAIT.maxMs
    if (ref !== undefined) return one(me, o.ledger.decision(parseRef(ref, 'd', true)), until)
    const lines: string[] = []
    const seen = new Set<number>()
    for (;;) {
      const d = o.ledger
        .openDecisions()
        .find(
          (d) =>
            !seen.has(d.id) &&
            YES_OR_NO.includes(d.reason) &&
            mayShow(todos, me, o.ledger.get(d.taskId)),
        )
      if (d === undefined) break
      seen.add(d.id)
      const { line, stop } = await one(me, d, until)
      lines.push(line)
      if (stop || now() >= until) break
    }
    return { line: lines.join('\n') || 'no decision of this session that takes yes or no is open' }
  }

  const result = async (method: string, params: Record<string, unknown>): Promise<object> => {
    if (method === 'initialize') {
      const asks = z
        .object({
          protocolVersion: z.string().optional(),
          capabilities: z.object({ elicitation: z.record(z.string(), z.unknown()).optional() }),
        })
        .parse(params)
      const e = asks.capabilities.elicitation
      // An empty one is form mode alone, as the protocol had it before modes (2025-06-18).
      elicits = e !== undefined && ('form' in e || Object.keys(e).length === 0)
      const v = asks.protocolVersion ?? ''
      return {
        protocolVersion: PROTOCOLS.includes(v) ? v : PROTOCOLS.at(-1),
        capabilities: { tools: {} },
        serverInfo: { name: 'nod', version: '1' },
      }
    }
    if (method === 'ping') return {}
    if (method === 'tools/list') {
      const decision = {
        type: 'string',
        description: 'd<n>, the decision; none shows each open one of this session in turn',
      }
      const inputSchema = { type: 'object', properties: { decision } }
      return { tools: [{ name: 'decide', description: DESCRIPTION, inputSchema }] }
    }
    if (method === 'tools/call') {
      const call = Called.parse(params)
      if (call.name !== 'decide') throw new Error(`no tool ${call.name}`)
      const out = await decide(call.arguments?.decision).catch(
        (error): Outcome => ({ line: message(error), refused: true }),
      )
      return { content: [{ type: 'text', text: out.line }], isError: out.refused === true }
    }
    throw Object.assign(new Error(`no method ${method}`), { code: -32601 })
  }

  return async (line) => {
    let m: z.infer<typeof Message>
    try {
      m = Message.parse(JSON.parse(line))
    } catch {
      send({ id: null, error: { code: -32700, message: 'not a JSON-RPC message' } })
      return
    }
    // The client's answer to a dialog nod showed.
    if (m.method === undefined) {
      const done = typeof m.id === 'string' ? waiting.get(m.id) : undefined
      const got = Elicited.safeParse(m.result)
      done?.(
        got.success ? got.data.action : { failed: m.error?.message ?? 'the client said nothing' },
      )
      return
    }
    // A notification (initialized, cancelled) needs nothing.
    if (m.id === undefined || m.id === null) return
    try {
      send({ id: m.id, result: await result(m.method, m.params ?? {}) })
    } catch (error) {
      const code = (error as { code?: number }).code ?? -32603
      send({ id: m.id, error: { code, message: message(error) } })
    }
  }
}

// Whether the session may show a decision of `task`: its work (Todos.isMine); for an orchestrator
// also that of the projects in its charge, and of the tasks in no project a session of its name added.
function mayShow(todos: Todos, me: Session, task: Task): boolean {
  if (todos.isMine(me.sessionKey, task)) return true
  if (me.role !== 'orchestrator') return false
  const project = todos.projectOf(task)
  if (project !== null) return todos.orchestratorOf(project) === me.name
  return todos.listener(null, task)?.name === me.name
}

// What the dialog says, all from the ledger: the task and its title, the decision and its kind,
// what it asks whole, and what each answer does. Control characters show as spaces, so none hides
// part of a command.
function dialogText(todos: Todos, d: Decision, task: Task): string {
  const todo = task.todoId === null ? null : todos.get(task.todoId)
  return [
    `nod d${d.id} ${d.reason} · ${taskLabel(task)}: ${clean(todo?.title ?? firstLineOf(task.brief))}`,
    '',
    ...d.question.split('\n').map(clean),
    '',
    `Accept says yes. Decline says no, which ${NO[d.reason]}. Esc leaves it open.`,
  ].join('\n')
}

const rows = (text: string): number =>
  text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(Bun.stringWidth(l) / COLUMNS)), 0)
