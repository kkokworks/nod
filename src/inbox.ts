import { z } from 'zod'
import { Ledger, type Notice } from './ledger'
import { type Project, Todos } from './todos'
import { allowedLine, firstLine, indent, oneLine, taskLabel } from './view'
import { message } from './worker'

// nod tells a project's session, the one nod open opened for it last, what `nod watch` would print
// for it: each of the project's tasks that ends (once its check and review are done) and each of
// its decisions that opens, and what a person sends it with `nod tell p<n>`. The ledger records
// each as a notice with the change itself (ledger.ts); sendNotices sends what is unsent into the
// session's inbox socket, as another Claude session on this machine does (SendMessage), after each
// notify and on each tick. What finds no session running, or a send that fails, waits for the next.
// ponytail: the line is Claude Code's own (2.1.310), not documented, and Claude Code answers
// nothing: one it drops (a format it no longer reads, an id it does not know) counts as sent.

// A local socket takes far less; a hook waits on it.
const SEND_TIMEOUT_MS = 5000

// What a session's SessionStart and SessionEnd hooks pass on stdin; only what nod reads.
export const InboxEvent = z.object({ session_id: z.string(), hook_event_name: z.string() })

// The hooks nod open gives a project session (openSettings in worker.ts): as it starts, where it
// takes messages (Claude Code exports the socket to its hooks), and what waited for it goes; once it
// ends, none, unless the session runs on elsewhere since (nod open of the same session in another
// terminal). A session nod open did not open changes nothing, so neither does the conversation
// /clear starts under a new ID: it hears nothing until nod open opens the project's session again.
export async function onInbox(
  ledger: Ledger,
  event: z.infer<typeof InboxEvent>,
  socket: string | undefined,
  send = sendLine,
): Promise<void> {
  const todos = new Todos(ledger)
  if (event.hook_event_name === 'SessionEnd') {
    todos.setSocket(event.session_id, null, socket || undefined)
    return
  }
  todos.setSocket(event.session_id, socket || null)
  await sendNotices(ledger, send)
}

// What every nod command run in a Claude session does first (cli.ts), for a project session its
// hooks never told nod of: one reopened with claude --resume, or opened before nod open gave it
// hooks. Claude Code exports the socket to its Bash too, so the session says where it takes
// messages now, or anew after it started again, and what waited for it goes. Returns why the
// session still hears nothing, for stderr: it is not the project's latest session, which alone
// hears, or nod knows no socket of it. A session nod open did not open, /clear's included, changes
// nothing and is told nothing.
// ponytail: with no SessionEnd hook such a session ends without saying so, and its socket stays
// until a send finds it gone (sendNotices); the hooks' risk of a reused path is the same.
export async function onCommand(
  ledger: Ledger,
  session: string | null,
  socket: string | undefined,
  send = sendLine,
): Promise<string | null> {
  const todos = new Todos(ledger)
  const place = session === null ? null : todos.sessionPlace(session)
  if (place === null) return null
  const p = `p${place.project.id}`
  const deaf = `nod: this session of ${p} hears nothing from nod`
  if (!place.latest) return `${deaf}: nod tells ${p}'s latest session, which nod open ${p} opens`
  if (socket && socket !== place.session.socket) {
    todos.setSocket(place.session.sessionId, socket)
    await sendNotices(ledger, send)
  } else if (!socket && place.session.socket === null) {
    return `${deaf}: Claude Code gave it no inbox socket (CLAUDE_CODE_MESSAGING_SOCKET); nod open ${p} opens it again`
  }
  return null
}

// `nod tell p<n>`: a person's words for the project's session, by the same way. Returns whether
// they went now; else they wait for the session as a notice does.
export async function tellProject(
  ledger: Ledger,
  projectId: number,
  text: string,
  actor: string,
  send = sendLine,
): Promise<boolean> {
  new Todos(ledger).project(projectId)
  const note = `nod tell from ${actor}:\n${text}`
  const id = ledger.addNotice({ projectId, event: 'tell', note })
  await sendNotices(ledger, send)
  return ledger.notice(id).sentAt !== null
}

// What notify does after an event: sends what waits, with a ledger of its own, and tells only
// stderr what went wrong, as nothing else may stop on it.
export async function tellSessions(home: string): Promise<void> {
  let ledger: Ledger | null = null
  try {
    ledger = new Ledger(home)
    await sendNotices(ledger)
  } catch (error) {
    console.error(`nod: could not tell the project sessions: ${message(error)}`)
  } finally {
    ledger?.db.close()
  }
}

// Sends each project's unsent notices, oldest first, to its latest session, all in one message. One
// of a task in no project, and a decision answered since, goes to none. A project with no session
// running keeps them. A send that fails keeps them too, and a socket that is gone (the session
// ended without its SessionEnd hook) is forgotten until the session says it again.
// ponytail: notices are marked sent before the send, so a process killed between the two loses
// them; and a session that starts again while another process sends to its old socket hears them
// only at the next send (a tick, an event). A lease on the mark would close both.
export async function sendNotices(ledger: Ledger, send = sendLine): Promise<void> {
  const todos = new Todos(ledger)
  const waiting = new Map<number, Notice[]>()
  for (const n of ledger.unsentNotices()) {
    const project =
      n.projectId ?? (n.taskId === null ? null : todos.projectOf(ledger.get(n.taskId)))
    const answered = n.decisionId !== null && ledger.decision(n.decisionId).answer !== null
    if (project === null || answered) ledger.claimNotices([n.id], null)
    else waiting.set(project, [...(waiting.get(project) ?? []), n])
  }
  for (const [projectId, notices] of waiting) {
    const session = todos.latestSession(projectId)
    const socket = session?.socket ?? null
    if (session === null || socket === null) continue
    const claimed = ledger.claimNotices(
      notices.map((n) => n.id),
      session.sessionId,
    )
    const these = notices.filter((n) => claimed.ids.includes(n.id))
    if (these.length === 0) continue
    try {
      const content = noticesText(ledger, todos.project(projectId), these)
      const said = {
        type: 'user',
        session_id: session.sessionId,
        message: { role: 'user', content },
      }
      await send(socket, `${JSON.stringify(said)}\n`)
    } catch (error) {
      ledger.unclaimNotices(claimed.ids, claimed.at)
      const { code } = Object(error) as { code?: unknown }
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        todos.setSocket(session.sessionId, null, socket)
      } else {
        console.error(`nod: could not tell p${projectId}'s session: ${message(error)}`)
      }
    }
  }
}

// One message for a project's session: which project, then each notice.
export function noticesText(ledger: Ledger, project: Project, notices: Notice[]): string {
  const count = notices.length === 1 ? 'a notice' : `${notices.length} notices, oldest first`
  const head = `nod, project p${project.id} ${project.title}: ${count}`
  return [head, ...notices.map((n) => noticeText(ledger, n))].join('\n\n')
}

// What the session does with each end, as it does with `nod watch`'s line.
const NEXT = {
  succeeded: (id: number) => `nod show ${id}, then send its result out`,
  error: (id: number) => `nod show ${id} says why; settle with the person what to do`,
  cancelled: (id: number) => `tell the person (nod show ${id})`,
}

// A notice as `nod watch` prints it, with the turn it came on (its attempt, counted from 1, or the
// decision's number) to tell one sent twice, and what to do next.
export function noticeText(ledger: Ledger, n: Notice): string {
  if (n.event === 'tell') return n.note ?? ''
  if (n.event === 'allowed') return allowedLine(n)
  const task = ledger.get(n.taskId ?? 0)
  if (n.event === 'decision') {
    const d = ledger.decision(n.decisionId ?? 0)
    return [
      `decision #${d.id} ${d.reason} (${taskLabel(task)}: ${oneLine(task.brief, 60)})`,
      indent(d.question),
      `next: tell the person; nod ${d.id} <their answer> answers it, nod drop ${d.id} drops it`,
    ].join('\n')
  }
  const turn = ledger.attempts(task.id).findIndex((a) => a.id === n.attemptId) + 1
  const attempt = turn === 0 ? '' : `, attempt ${turn}`
  const note = firstLine(n.note || task.brief)
  return `${taskLabel(task)} ${n.event}${attempt}: ${note}\nnext: ${NEXT[n.event](task.id)}`
}

// One line into a session's inbox socket, done once the socket took all of it and nod closed its
// side: Claude Code answers nothing. Bun.connect, not node:net, whose failed connect bun test
// reports as an error even once handled (1.3.14). A write may take part of the line; the rest goes
// as the socket drains.
export async function sendLine(
  socket: string,
  line: string,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<void> {
  let rest = Buffer.from(line)
  const sent = Promise.withResolvers<void>()
  // Settled by whichever comes first; one that comes after is no rejection left unhandled.
  sent.promise.catch(() => {})
  let gaveUp = false
  const write = (s: Bun.Socket): void => {
    // Given up on, it counts as not sent and goes again later: no line, or no end of one, goes now.
    if (gaveUp) {
      s.terminate()
      return
    }
    const n = s.write(rest)
    if (n > 0) rest = rest.subarray(n)
    if (rest.length > 0) return
    // Settled first: end() runs the close handler before it returns (measured with a socket server
    // that reads the whole line, Bun 1.3.14).
    sent.resolve()
    s.end()
  }
  // The time counts from before the connection: one that hangs in connecting is given up too.
  const timer = setTimeout(() => {
    gaveUp = true
    sent.reject(new Error(`${socket} took no line in ${timeoutMs} ms`))
  }, timeoutMs)
  Bun.connect({
    unix: socket,
    socket: {
      open: write,
      drain: write,
      data: () => {},
      error: (_, error) => sent.reject(error),
      close: () => {
        if (rest.length > 0)
          sent.reject(new Error(`${socket} closed before it took the whole line`))
      },
    },
  }).then(
    (conn) => sent.promise.catch(() => conn.terminate()),
    (error) => sent.reject(error),
  )
  try {
    await sent.promise
  } finally {
    clearTimeout(timer)
  }
}
