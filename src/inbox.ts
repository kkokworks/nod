import { existsSync, lstatSync } from 'node:fs'
import { z } from 'zod'
import { Ledger, type Notice, type Task } from './ledger'
import { message, unbroken } from './proc'
import { type Project, type Session, Todos } from './todos'
import { allowedLine, firstLine, indent, oneLine, taskLabel } from './view'

// nod tells a project's session, the one nod open opened for it last, what happens to its work:
// each of the project's tasks that ends (once its check and review are done) and each of
// its decisions that opens, and what a person sends it with `nod tell p<n>`; also what nod allowed
// a worker itself, and each decision a person answered elsewhere (decisions.ts). An orchestrator
// hears the same of the tasks in no project (Todos.listener). The ledger records each as a
// notice with the change itself (ledger.ts); sendNotices sends what is unsent into the session's
// inbox socket, as another Claude session on this machine does (SendMessage), after each notify and
// on each tick. What finds no session running, or a send that fails, waits for the next.
// ponytail: the line is Claude Code's own (2.1.310), not documented, and Claude Code answers
// nothing: one it drops (a format it no longer reads, an id it does not know) counts as sent.

// A local socket takes far less; a hook waits on it.
const SEND_TIMEOUT_MS = 5000
// How much of a person's answer an `answered` notice shows, on one line, with `…` after one cut.
const ANSWER_LIMIT = 200

// What a session's SessionStart and SessionEnd hooks pass on stdin; only what nod reads.
export const InboxEvent = z.object({ session_id: z.string(), hook_event_name: z.string() })

// The hooks nod open gives a session (openSettings in settings.ts): as it starts, where it takes
// messages (Claude Code exports the socket to its hooks), and what waited for it goes; once it
// ends, none, unless the session runs on elsewhere since (nod open of the same session in another
// terminal). A session nod open did not open records nothing, only takes its socket from any
// session that had it (setSocket), so the conversation /clear starts under a new ID hears nothing
// until nod open opens the project's session again.
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

// What a session nod knows hears for: `ref`, what nod open opens it by; its project, none in a role
// of no project; and whether it is the latest of those, which alone hears. Null for any other
// session.
function hearing(todos: Todos, sessionKey: string) {
  const session = todos.session(sessionKey)
  if (session === null) return null
  const place = todos.sessionPlace(sessionKey)
  const ref = place === null ? session.name : `p${place.project.id}`
  const latest = place?.latest ?? todos.latestNamed(session.name)?.id === session.id
  return { session, projectId: place?.project.id ?? null, ref, latest }
}

// What every nod command run in a Claude session does first (cli.ts), for a session nod knows that
// its hooks never told nod of: one reopened with claude --resume, opened before nod open gave it
// hooks, or that claimed a role. Claude Code exports the socket to its Bash too, so the session says
// where it takes messages now, or anew after it started again, and what waited for it goes. A
// socket is one session's (setSocket), so one said here leaves the session nod told there before:
// one its process ran until /clear or /resume with no hook to say so, whose old ID the socket drops.
// Returns what to tell stderr, or null: why such a session still hears nothing (it is not the
// latest, which alone hears, or nod knows no socket of it), and which latest session lost its socket
// to this one. `warned` gets each project it told of, which unheardWork does not tell of again in
// the same command. Any other session is told nothing here (unheardWork speaks to it as it sets a
// project's work going) and changes nothing.
// ponytail: with no SessionEnd hook such a session ends, or goes on under a new ID, without saying
// so: its socket stays until a send finds it gone (sendNotices) or another session says it, and a
// line sent to the old ID there meanwhile is dropped yet counts as sent.
export async function onCommand(
  ledger: Ledger,
  session: string | null,
  socket: string | undefined,
  send = sendLine,
  warned = new Set<number>(),
): Promise<string | null> {
  if (session === null) return null
  const todos = new Todos(ledger)
  const me = hearing(todos, session)
  const said = socket && socket !== me?.session.socket ? socket : null
  const had = said === null ? null : todos.sessionAt(said)
  if (said !== null && (me !== null || had !== null)) todos.setSocket(session, said)
  const told: string[] = []
  const tell = (of: { projectId: number | null }, line: string): void => {
    if (of.projectId !== null) warned.add(of.projectId)
    told.push(line)
  }
  const lost = had === null ? null : hearing(todos, had.sessionKey)
  if (lost?.latest && lost.ref !== me?.ref) {
    tell(
      lost,
      `nod: ${lost.ref}'s session took messages at this session's inbox socket, which runs another session now (/clear or /resume in its terminal), so it hears nothing from nod; nod open ${lost.ref} opens it again`,
    )
  }
  if (me !== null) {
    const deaf = `nod: this session of ${me.ref} hears nothing from nod`
    if (!me.latest) {
      tell(me, `${deaf}: nod tells ${me.ref}'s latest session, which nod open ${me.ref} opens`)
    } else if (said !== null) {
      await sendNotices(ledger, send)
    } else if (!socket && me.session.socket === null) {
      tell(
        me,
        `${deaf}: Claude Code gave it no inbox socket (CLAUDE_CODE_MESSAGING_SOCKET); nod open ${me.ref} opens it again`,
      )
    }
  }
  return told.length === 0 ? null : told.join('\n')
}

// Whether a session is on, as far as nod can tell: it said where it takes messages, and that socket
// is there.
export const takesMessages = (session: Session | null): boolean =>
  session !== null && session.socket !== null && existsSync(session.socket)

// What a Claude session hears as it sets a project's work going (nod add, tell, an answer, resume,
// restart) though it is not the project's latest session, the one nod tells: a line for stderr for
// each project of the tasks `ids` whose latest session cannot hear either (there is none, nod knows
// no socket of it, or its socket file is gone), so the decisions and ends that work brings wait
// unheard. Each project once, and none of `warned`, which onCommand told of already, and which
// gets those told here. Nothing for a person's shell (no session), nor for the project's latest
// session, which onCommand speaks for. --mine shows only the session's own tasks, so the line
// names plain `nod` and `nod ls` for work another session added.
export function unheardWork(
  ledger: Ledger,
  session: string | null,
  ids: number[],
  warned = new Set<number>(),
): string[] {
  if (session === null) return []
  const todos = new Todos(ledger)
  const work = new Map<number, Task[]>()
  for (const id of ids) {
    const task = ledger.get(id)
    const project = todos.projectOf(task)
    if (project !== null) work.set(project, [...(work.get(project) ?? []), task])
  }
  const told: string[] = []
  for (const [projectId, tasks] of work) {
    const latest = todos.latestSession(projectId)
    if (warned.has(projectId) || latest?.sessionKey === session) continue
    if (takesMessages(latest)) continue
    const p = `p${projectId}`
    const why =
      latest === null
        ? 'nod open never opened one'
        : latest.socket === null
          ? 'it takes no messages now'
          : 'its inbox socket is gone'
    const mine = tasks.every((t) => todos.isMine(session, t)) ? ' --mine' : ''
    warned.add(projectId)
    told.push(
      `nod: ${p}'s session hears nothing from nod (${why}), so the decisions and ends of this work wait unheard until nod open ${p} opens ${latest === null ? 'one' : 'it again'}; meanwhile nod${mine} and nod ls${mine} here show them`,
    )
  }
  return told
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
    console.error(`nod: could not tell the sessions: ${message(error)}`)
  } finally {
    ledger?.db.close()
  }
}

// Sends each session its unsent notices, oldest first, all in one message: each project's to its
// latest session, and those of tasks in no project to the orchestrator that hears of them
// (Todos.listener). One of a task in no project with no orchestrator session ever opened, and a
// decision's opening once it was answered, goes to none. A session not running keeps them. A send
// that fails keeps them too, and a socket that is gone (the session ended without its SessionEnd
// hook, `ended`) is forgotten until the session says it again.
// Notices are marked sent before the send, so the two are unbroken: a hook that nod ends by closing
// its terminal (drop) ends once the send is done, not between the two, with the notices it marked.
// ponytail: a process killed outright (SIGKILL) between the two still loses them; and a session
// that starts again while another process sends to its old socket hears them only at the next send
// (a tick, an event). A lease on the mark would close both.
export async function sendNotices(
  ledger: Ledger,
  send = sendLine,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const todos = new Todos(ledger)
  let waiting: { notice: Notice; projectId: number | null; root: string | null }[] = []
  for (const notice of ledger.unsentNotices()) {
    const task = notice.taskId === null ? null : ledger.get(notice.taskId)
    const projectId = notice.projectId ?? (task === null ? null : todos.projectOf(task))
    const answered =
      notice.event === 'decision' &&
      notice.decisionId !== null &&
      ledger.decision(notice.decisionId).answer !== null
    const root = task?.rootSession ?? null
    if (answered || (projectId === null && todos.listener(null, root) === null)) {
      ledger.claimNotices([notice.id], null)
    } else waiting.push({ notice, projectId, root })
  }
  const hears = (w: (typeof waiting)[number]): Session | null => todos.listener(w.projectId, w.root)
  // Session by session, each read as its turn comes, for each notice: the send before may have taken
  // a while, and a session opened since. A session is of one project or none.
  // ponytail: reads who hears each notice once per session sent to; what waits is a few dozen rows.
  for (let [first] = waiting; first !== undefined; [first] = waiting) {
    const { projectId } = first
    const session = hears(first)
    const mine = waiting.filter((w) => hears(w)?.id === session?.id)
    waiting = waiting.filter((w) => !mine.includes(w))
    const notices = mine.map((w) => w.notice)
    const socket = session?.socket ?? null
    if (session === null || socket === null) continue
    await unbroken(async () => {
      const claimed = ledger.claimNotices(
        notices.map((n) => n.id),
        session.id,
      )
      const these = notices.filter((n) => claimed.ids.includes(n.id))
      if (these.length === 0) return
      try {
        const project = projectId === null ? null : todos.project(projectId)
        const content = noticesText(ledger, project, these)
        const said = {
          type: 'user',
          session_id: session.sessionKey,
          message: { role: 'user', content },
        }
        await send(socket, `${JSON.stringify(said)}\n`)
      } catch (error) {
        ledger.unclaimNotices(claimed.ids, claimed.at)
        const { code } = Object(error) as { code?: unknown }
        if (code !== 'ENOENT' && code !== 'ECONNREFUSED') {
          const of = projectId === null ? session.name : `p${projectId}`
          console.error(`nod: could not tell ${of}'s session: ${message(error)}`)
        } else if (ended(socket, env)) {
          todos.setSocket(session.sessionKey, null, socket)
        }
      }
    })
  }
}

// Whether a connect to `socket` that found nobody there shows the session ended. Outside a sandbox
// it does: a live session listens, and Claude Code removes its socket as it ends. Bun reports a
// connect Claude Code's sandbox refuses as ENOENT too, the file still there (1.3.14; the kernel
// says EPERM, docs/design.md), so there only the file being gone shows it, and what waits goes with
// the next send from outside the sandbox (a tick, a hook). A file the sandbox hides shows nothing.
function ended(socket: string, env: Record<string, string | undefined>): boolean {
  if (env.SANDBOX_RUNTIME !== '1') return true
  try {
    lstatSync(socket)
    return false
  } catch (error) {
    return (error as { code?: unknown }).code === 'ENOENT'
  }
}

// One message for a session: which project, or none, then each notice.
function noticesText(ledger: Ledger, project: Project | null, notices: Notice[]): string {
  const count = notices.length === 1 ? 'a notice' : `${notices.length} notices, oldest first`
  const whose = project === null ? 'tasks in no project' : `project p${project.id} ${project.title}`
  const head = `nod, ${whose}: ${count}`
  return [head, ...notices.map((n) => noticeText(ledger, n))].join('\n\n')
}

// What the session does with each end.
const NEXT = {
  succeeded: (id: number) => `nod show n${id}, then send its result out`,
  error: (id: number) => `nod show n${id} says why; settle with the person what to do`,
  cancelled: (id: number) => `tell the person (nod show n${id})`,
}

// A notice as the session hears it, with the turn it came on (its attempt, counted from 1, or the
// decision's number) to tell one sent twice, and what to do next.
function noticeText(ledger: Ledger, n: Notice): string {
  if (n.event === 'tell') return n.note ?? ''
  if (n.event === 'allowed') return allowedLine(n)
  const task = ledger.get(n.taskId ?? 0)
  if (n.event === 'answered') {
    const d = ledger.decision(n.decisionId ?? 0)
    // What the person said: the decision's answer, or the notice's own words for one they went on
    // past (a tell). By code point, so a character outside the BMP (an emoji) is not cut in half.
    const said = [...(n.note ?? d.answer ?? '').replace(/\r\n|\r|\n/g, ' ')]
    const cut = `${said.slice(0, ANSWER_LIMIT).join('')}${said.length > ANSWER_LIMIT ? '…' : ''}`
    return [
      `decision d${d.id} ${d.reason} answered by the person (${taskLabel(task)}): ${cut}`,
      'next: tell the person in a line; it is closed, so answer it no more',
    ].join('\n')
  }
  if (n.event === 'decision') {
    const d = ledger.decision(n.decisionId ?? 0)
    return [
      `decision d${d.id} ${d.reason} (${taskLabel(task)}: ${oneLine(task.brief, 60)})`,
      indent(d.question),
      `next: tell the person; nod d${d.id} <their answer> answers it, nod drop d${d.id} drops it`,
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
