import { afterAll, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inboxServer, inboxTest } from '../test/inbox-server'
import { socketsParent, tempDirs } from '../test/tmp'
import { onCommand, onInbox, sendNotices, tellProject, unheardWork } from './inbox'
import { Ledger, type NewTask } from './ledger'
import { notify } from './notify'
import { Todos } from './todos'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const cli = resolve(import.meta.dir, 'cli.ts')
const A = 'aaaa1111-0000-4000-8000-00000000000a'
const B = 'bbbb2222-0000-4000-8000-00000000000b'
const C = 'cccc3333-0000-4000-8000-00000000000c'

const brief = (text: string): NewTask => ({
  brief: text,
  repo: null,
  branch: null,
  checkCmd: null,
  model: null,
  after: [],
  triggerId: null,
  issue: null,
})

type Said = { type: string; session_id: string; message: { role: string; content: string } }

// A ledger with projects p1 Release and p2 Health, and a send that keeps what it is handed.
function setup() {
  const home = tmp.make('nod-inbox-')
  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  const p = todos.addProject({ title: 'Release', outcome: null }, 'human')
  const q = todos.addProject({ title: 'Health', outcome: null }, 'human')
  const task = (text: string, project: number | null = p.id): number =>
    todos.delegateNew(brief(text), project, 'human')
  // A turn of the task's worker, ended as `outcome` with `summary`.
  const turn = (taskId: number, outcome: 'succeeded' | 'failed', summary: string): number => {
    const id = ledger.startAttempt({
      taskId,
      kind: 'start',
      decisionId: null,
      sessionId: 's',
      prompt: 'p',
    })
    ledger.endAttempt(id, { outcome, summary, report: summary })
    return id
  }
  const sent: ({ socket: string } & Said)[] = []
  const send = async (socket: string, line: string): Promise<void> => {
    expect(line.endsWith('\n')).toBe(true)
    sent.push({ socket, ...(JSON.parse(line) as Said) })
  }
  return { home, ledger, todos, p, q, task, turn, sent, send }
}

test("each end of a project's task and each decision opened on one go once, in one message, to the project's latest session by its id", async () => {
  const { ledger, todos, p, task, turn, sent, send } = setup()
  todos.addSession(p.id, A, '/work/one')
  todos.setSocket(A, '/socks/a')
  todos.addSession(p.id, B, '/work/two')
  todos.setSocket(B, '/socks/b')

  const shipped = task('Add the export button')
  turn(shipped, 'succeeded', 'Added the export button\nwith a test')
  ledger.succeed(shipped)
  const broke = task('Fix the build')
  turn(broke, 'failed', 'tried')
  ledger.error(broke, 'the worktree is gone\nmore')
  const dropped = task('Drop me')
  ledger.drop(ledger.ask(dropped, turn(dropped, 'failed', 'stuck'), 'question', 'Go on?'))
  const asking = task('Pick a branch')
  turn(asking, 'succeeded', 'first try')
  ledger.ask(asking, turn(asking, 'failed', 'which'), 'question', 'Which branch?\nmain or next')

  await sendNotices(ledger, send)
  expect(sent).toEqual([
    {
      socket: '/socks/b',
      type: 'user',
      session_id: B,
      message: {
        role: 'user',
        content: [
          'nod, project p1 Release: 4 notices, oldest first',
          'task n1 t1 succeeded, attempt 1: Added the export button\nnext: nod show n1, then send its result out',
          'task n2 t2 error, attempt 1: the worktree is gone\nnext: nod show n2 says why; settle with the person what to do',
          // Its decision was answered (dropped) before anything went, so only its end goes.
          'task n3 t3 cancelled, attempt 1: Drop me\nnext: tell the person (nod show n3)',
          'decision d2 question (task n4 t4: Pick a branch)\n  Which branch?\n  main or next\nnext: tell the person; nod d2 <their answer> answers it, nod drop d2 drops it',
        ].join('\n\n'),
      },
    },
  ])
  // What went does not go again; the next end goes on its own.
  await sendNotices(ledger, send)
  expect(sent).toHaveLength(1)
  turn(broke, 'succeeded', 'Fixed the build')
  ledger.succeed(broke)
  await sendNotices(ledger, send)
  expect(sent.map((s) => s.message.content)).toEqual([
    expect.any(String),
    'nod, project p1 Release: a notice\n\ntask n2 t2 succeeded, attempt 2: Fixed the build\nnext: nod show n2, then send its result out',
  ])
  expect(ledger.unsentNotices()).toEqual([])
})

test("a project's session hears only its own project's work; work in no project goes to none", async () => {
  const { ledger, todos, p, q, task, sent, send } = setup()
  todos.addSession(p.id, A, '/work/one')
  todos.setSocket(A, '/socks/a')
  todos.addSession(q.id, C, '/work/one')
  todos.setSocket(C, '/socks/c')

  ledger.succeed(task('Release work'))
  ledger.succeed(task('Health work', q.id))
  ledger.succeed(task('Loose work', null))
  await sendNotices(ledger, send)
  expect(sent.map((s) => [s.socket, s.session_id, s.message.content])).toEqual([
    ['/socks/a', A, expect.stringContaining('task n1 t1 succeeded: Release work')],
    ['/socks/c', C, expect.stringContaining('task n2 t2 succeeded: Health work')],
  ])
  expect(sent.map((s) => s.message.content).join()).not.toContain('Loose work')
  expect(ledger.unsentNotices()).toEqual([])
})

test('notices wait while the project has no session taking messages, and go in one message once its hook says where it takes them', async () => {
  const { ledger, todos, p, task, turn, sent, send } = setup()
  const start = (session: string, socket: string) =>
    onInbox(ledger, { session_id: session, hook_event_name: 'SessionStart' }, socket, send)

  ledger.succeed(task('First'))
  const asking = task('Second')
  ledger.ask(asking, turn(asking, 'failed', 'q'), 'permission', 'Allow it?')
  await sendNotices(ledger, send)
  // A session nod open opened, whose hooks have not said yet; and one nod open did not open.
  todos.addSession(p.id, A, '/work/one')
  await sendNotices(ledger, send)
  await start(C, '/socks/c')
  expect(sent).toEqual([])
  expect(ledger.unsentNotices()).toHaveLength(2)

  await start(A, '/socks/a')
  expect(sent.map((s) => [s.socket, s.session_id])).toEqual([['/socks/a', A]])
  expect(sent[0]?.message.content).toStartWith('nod, project p1 Release: 2 notices, oldest first')
  expect(sent[0]?.message.content).toContain('task n1 t1 succeeded: First')
  expect(sent[0]?.message.content).toContain('decision d1 permission (task n2 t2: Second)')

  // The same session opened in another terminal since: the end of the first leaves the second's.
  await start(A, '/socks/b')
  await onInbox(ledger, { session_id: A, hook_event_name: 'SessionEnd' }, '/socks/a', send)
  expect(todos.latestSession(p.id)?.socket).toBe('/socks/b')
  // Once it ends it takes none, until it starts again, maybe elsewhere.
  await onInbox(ledger, { session_id: A, hook_event_name: 'SessionEnd' }, '/socks/b', send)
  expect(todos.latestSession(p.id)?.socket).toBeNull()
  ledger.error(task('Third'), 'boom')
  await sendNotices(ledger, send)
  expect(sent).toHaveLength(1)
  await start(A, '/socks/a2')
  expect(sent.map((s) => [s.socket, s.session_id])).toEqual([
    ['/socks/a', A],
    ['/socks/a2', A],
  ])
  expect(sent[1]?.message.content).toContain('task n3 t3 error: boom')
})

test("a nod command in a project session its hooks never told nod of says where it takes messages, and what waited goes; another session's changes nothing", async () => {
  const { ledger, todos, p, task, sent, send } = setup()
  // Opened before nod open gave it hooks, or reopened with claude --resume: no socket.
  todos.addSession(p.id, A, '/work/one')
  ledger.succeed(task('First'))
  await tellProject(ledger, p.id, 'Look at the logs', 'human', send)
  expect(ledger.unsentNotices()).toHaveLength(2)

  // Not a project's session: no socket, no send, no word.
  expect(await onCommand(ledger, C, '/socks/c', send)).toBeNull()
  expect(await onCommand(ledger, null, '/socks/c', send)).toBeNull()
  expect(todos.latestSession(p.id)?.socket).toBeNull()
  expect(sent).toEqual([])

  expect(await onCommand(ledger, A, '/socks/a', send)).toBeNull()
  expect(todos.latestSession(p.id)?.socket).toBe('/socks/a')
  expect(sent.map((s) => [s.socket, s.session_id])).toEqual([['/socks/a', A]])
  expect(sent[0]?.message.content).toStartWith('nod, project p1 Release: 2 notices, oldest first')
  expect(ledger.unsentNotices()).toEqual([])
  // The next command sends nothing again; the same session in a new process says its new socket.
  await onCommand(ledger, A, '/socks/a', send)
  expect(sent).toHaveLength(1)
  expect(await onCommand(ledger, A, '/socks/a2', send)).toBeNull()
  expect(todos.latestSession(p.id)?.socket).toBe('/socks/a2')
  ledger.error(task('Second'), 'boom')
  await sendNotices(ledger, send)
  expect(sent.map((s) => s.socket)).toEqual(['/socks/a', '/socks/a2'])

  // A session that cannot hear says so: one with no socket, and one that is no longer the project's
  // latest, whose socket nod keeps but tells nothing at.
  todos.addSession(p.id, B, '/work/two')
  expect(await onCommand(ledger, B, undefined, send)).toBe(
    'nod: this session of p1 hears nothing from nod: Claude Code gave it no inbox socket (CLAUDE_CODE_MESSAGING_SOCKET); nod open p1 opens it again',
  )
  expect(await onCommand(ledger, A, '/socks/a3', send)).toBe(
    "nod: this session of p1 hears nothing from nod: nod tells p1's latest session, which nod open p1 opens",
  )
  ledger.succeed(task('Third'))
  await sendNotices(ledger, send)
  expect(sent).toHaveLength(2)
  // One whose hook told nod its socket hears, with or without the variable.
  expect(await onCommand(ledger, B, '/socks/b', send)).toBeNull()
  expect(await onCommand(ledger, B, undefined, send)).toBeNull()
  expect(sent.map((s) => [s.socket, s.session_id])).toEqual([
    ['/socks/a', A],
    ['/socks/a2', A],
    ['/socks/b', B],
  ])
})

test("a socket is one session's: the ID /clear or /resume goes on under takes it from the old one at its first nod command and says so, so what comes then waits; a session starting at it takes it too", async () => {
  const { ledger, todos, p, q, task, sent, send } = setup()
  const D = 'dddd4444-0000-4000-8000-00000000000d'
  todos.addSession(p.id, A, '/work/one')
  // Reopened with claude --resume, so no hook says when it ends or clears.
  await onCommand(ledger, A, '/socks/a', send)
  expect(todos.latestSession(p.id)?.socket).toBe('/socks/a')
  // A command elsewhere leaves it.
  expect(await onCommand(ledger, C, '/socks/c', send)).toBeNull()
  expect(todos.latestSession(p.id)?.socket).toBe('/socks/a')
  // /clear: the same process and socket, under an ID nod open did not open, which the old ID's
  // lines no longer reach.
  expect(await onCommand(ledger, C, '/socks/a', send)).toBe(
    "nod: p1's session took messages at this session's inbox socket, which runs another session now (/clear or /resume in its terminal), so it hears nothing from nod; nod open p1 opens it again",
  )
  expect(todos.latestSession(p.id)?.socket).toBeNull()
  ledger.succeed(task('First'))
  await sendNotices(ledger, send)
  expect(sent).toEqual([])
  expect(ledger.unsentNotices()).toHaveLength(1)

  // A newer session of p1, then /resume of the older one in its process: the older takes the
  // socket, and says it is not the one nod tells.
  todos.addSession(p.id, B, '/work/two')
  expect(await onCommand(ledger, B, '/socks/b', send)).toBeNull()
  expect(sent.map((s) => [s.socket, s.session_id])).toEqual([['/socks/b', B]])
  expect(await onCommand(ledger, A, '/socks/b', send)).toBe(
    "nod: this session of p1 hears nothing from nod: nod tells p1's latest session, which nod open p1 opens",
  )
  expect(todos.latestSession(p.id)?.socket).toBeNull()
  ledger.succeed(task('Second'))
  await sendNotices(ledger, send)
  expect(sent).toHaveLength(1)

  // nod open opens p1's session again; it ends without its hook, and another project's session
  // starts where its socket was.
  await onInbox(ledger, { session_id: B, hook_event_name: 'SessionStart' }, '/socks/b2', send)
  expect(sent.map((s) => [s.socket, s.session_id])).toEqual([
    ['/socks/b', B],
    ['/socks/b2', B],
  ])
  todos.addSession(q.id, D, '/work/three')
  await onInbox(ledger, { session_id: D, hook_event_name: 'SessionStart' }, '/socks/b2', send)
  expect(todos.latestSession(p.id)?.socket).toBeNull()
  expect(todos.latestSession(q.id)?.socket).toBe('/socks/b2')
})

test('a send that fails keeps the notices for the next and leaves the change it tells of as it is; a socket gone is forgotten unless the session said another since', async () => {
  const { ledger, todos, p, task, sent, send } = setup()
  todos.addSession(p.id, A, '/work/one')
  todos.setSocket(A, '/socks/a')
  const id = task('Ship it')
  ledger.succeed(id)

  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await sendNotices(ledger, async () => {
      throw new Error('the line went nowhere')
    })
    expect(errors.mock.calls.map(([line]) => String(line))).toEqual([
      "nod: could not tell p1's session: the line went nowhere",
    ])
  } finally {
    errors.mockRestore()
  }
  expect(ledger.get(id).status).toBe('succeeded')
  expect(ledger.unsentNotices()).toHaveLength(1)
  expect(todos.latestSession(p.id)?.socket).toBe('/socks/a')

  // The session started again while the send to its old socket failed: its new one stays.
  await sendNotices(ledger, async () => {
    todos.setSocket(A, '/socks/a2')
    throw Object.assign(new Error('connect ENOENT /socks/a'), { code: 'ENOENT' })
  })
  expect(todos.latestSession(p.id)?.socket).toBe('/socks/a2')
  // It ended without its SessionEnd hook: nothing takes messages there.
  await sendNotices(ledger, async () => {
    throw Object.assign(new Error('connect ECONNREFUSED /socks/a2'), { code: 'ECONNREFUSED' })
  })
  expect(todos.latestSession(p.id)?.socket).toBeNull()
  expect(ledger.unsentNotices()).toHaveLength(1)

  todos.setSocket(A, '/socks/a3')
  await sendNotices(ledger, send)
  expect(sent.map((s) => s.message.content)).toEqual([
    expect.stringContaining('task n1 t1 succeeded: Ship it'),
  ])
})

test('a hangup in the middle of a send, as nod closing the terminal of the hook that sends, ends the process once the notices it marked sent have gone', async () => {
  const { home, todos, p, task, ledger } = setup()
  todos.addSession(p.id, A, '/work/one')
  todos.setSocket(A, '/socks/a')
  ledger.succeed(task('Ship it'))
  const dir = tmp.make('nod-inbox-hangup-')
  const [go, out] = [join(dir, 'go'), join(dir, 'out')]
  // The send waits for the test, which hangs the process up first.
  const script = `import { existsSync, writeFileSync } from 'node:fs'
import { sendNotices } from ${JSON.stringify(join(import.meta.dir, 'inbox.ts'))}
import { Ledger } from ${JSON.stringify(join(import.meta.dir, 'ledger.ts'))}
await sendNotices(new Ledger(${JSON.stringify(home)}), async (_socket, line) => {
  console.log('sending')
  while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(20)
  writeFileSync(${JSON.stringify(out)}, line)
})`
  const proc = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'inherit' })
  const reader = proc.stdout.getReader()
  let said = ''
  while (!said.includes('sending\n')) {
    const r = await reader.read()
    if (r.done) break
    said += Buffer.from(r.value).toString()
  }
  proc.kill('SIGHUP')
  writeFileSync(go, '')
  await proc.exited
  expect(existsSync(out)).toBe(true)
  expect(readFileSync(out, 'utf8')).toContain('task n1 t1 succeeded: Ship it')
  // It still ends on the signal.
  expect(proc.signalCode).toBe('SIGHUP')
  expect(ledger.unsentNotices()).toEqual([])
}, 10_000)

test("in Claude Code's sandbox a refused connect keeps a socket whose file is there, as Bun reports it as it does one gone; a file that is gone, or a refusal outside the sandbox, forgets it", async () => {
  const { ledger, todos, p, task } = setup()
  const dir = tmp.make('nod-inbox-refused-')
  // A live session's socket file: one the sandbox lets nod see but not connect to.
  const live = join(dir, 'live.sock')
  writeFileSync(live, '')
  todos.addSession(p.id, A, '/work/one')
  todos.setSocket(A, live)
  ledger.succeed(task('Ship it'))
  // What Bun 1.3.14 throws for a connect the sandbox refuses, and for a socket gone (measured).
  const refused = async (): Promise<void> => {
    throw Object.assign(new Error('Failed to connect'), { code: 'ENOENT', errno: -2 })
  }
  const sandbox = { SANDBOX_RUNTIME: '1' }

  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await sendNotices(ledger, refused, sandbox)
    expect(errors).not.toHaveBeenCalled()
  } finally {
    errors.mockRestore()
  }
  expect(todos.latestSession(p.id)?.socket).toBe(live)
  expect(ledger.unsentNotices()).toHaveLength(1)

  // The session ended: Claude Code removed its socket file.
  todos.setSocket(A, join(dir, 'ended.sock'))
  await sendNotices(ledger, refused, sandbox)
  expect(todos.latestSession(p.id)?.socket).toBeNull()

  // Outside a sandbox nothing refuses a connect: a file nobody listens on is a session that ended.
  todos.setSocket(A, live)
  await sendNotices(ledger, refused, {})
  expect(todos.latestSession(p.id)?.socket).toBeNull()
  expect(ledger.unsentNotices()).toHaveLength(1)
})

test('notify sends what waits for the project sessions; with no socket file there, the notice waits, the end stands and nothing is said', async () => {
  const { home, ledger, todos, p, task } = setup()
  todos.addSession(p.id, A, '/work/one')
  todos.setSocket(A, join(tmp.make('nod-inbox-gone-'), 'ended.sock'))
  const id = task('Ship it')
  ledger.succeed(id)
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await notify(home, {
      event: 'succeeded',
      task: { id, brief: 'Ship it', issue: null },
      summary: '',
    })
    expect(errors).not.toHaveBeenCalled()
  } finally {
    errors.mockRestore()
  }
  // It tried the socket, found the session gone, and forgot it.
  expect(todos.latestSession(p.id)?.socket).toBeNull()
  expect(ledger.get(id).status).toBe('succeeded')
  expect(ledger.unsentNotices()).toHaveLength(1)
})

test('of two sends at once, each notice goes in one', async () => {
  const { home, ledger, todos, p, task, sent, send } = setup()
  todos.addSession(p.id, A, '/work/one')
  todos.setSocket(A, '/socks/a')
  ledger.succeed(task('Once'))
  // Another process sends while this one's line is on its way.
  await sendNotices(ledger, async (socket, line) => {
    await sendNotices(ledger, send)
    await send(socket, line)
  })
  expect(sent).toHaveLength(1)
  expect(sent[0]?.message.content).toContain('task n1 t1 succeeded: Once')

  // Two processes that both read a notice as unsent before either marks it: one marks it.
  ledger.succeed(task('Twice'))
  const other = new Ledger(home)
  const [mine, theirs] = [ledger.unsentNotices(), other.unsentNotices()]
  expect(mine.map((n) => n.id)).toEqual(theirs.map((n) => n.id))
  const ids = mine.map((n) => n.id)
  expect(ledger.claimNotices(ids, A).ids).toEqual(ids)
  expect(other.claimNotices(ids, A).ids).toEqual([])
  other.db.close()
})

test("nod tell p<n> sends a person's words into the project's session, or keeps them until it takes messages", async () => {
  const { ledger, todos, p, sent, send } = setup()
  expect(await tellProject(ledger, p.id, 'Look at the logs', 'human', send)).toBe(false)
  todos.addSession(p.id, A, '/work/one')
  await onInbox(ledger, { session_id: A, hook_event_name: 'SessionStart' }, '/socks/a', send)
  expect(await tellProject(ledger, p.id, 'And the metrics', 'claude:1234abcd', send)).toBe(true)
  expect(sent.map((s) => [s.session_id, s.message.content])).toEqual([
    [A, 'nod, project p1 Release: a notice\n\nnod tell from human:\nLook at the logs'],
    [A, 'nod, project p1 Release: a notice\n\nnod tell from claude:1234abcd:\nAnd the metrics'],
  ])
  await expect(tellProject(ledger, 9, 'nobody', 'human', send)).rejects.toThrow('no project p9')
})

test('nod open sessions report their inbox through nod hook inbox, and nod tell p<n> keeps what no session takes', async () => {
  const { home, ledger, todos, p } = setup()
  todos.addSession(p.id, A, '/work/one')
  const env = { ...process.env, NOD_HOME: home, NOD_ACTOR: 'human' }
  const run = async (input: string, nodHome = home): Promise<string> => {
    const proc = Bun.spawn(['bun', cli, 'hook', 'inbox'], {
      env: { ...env, NOD_HOME: nodHome, CLAUDE_CODE_MESSAGING_SOCKET: '/socks/none' },
      stdin: new Blob([input]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // Whatever goes wrong, the session starts and ends: 0, and only stderr says why.
    expect(await proc.exited).toBe(0)
    return new Response(proc.stdout).text()
  }
  const hook = (event: string): Promise<string> =>
    run(JSON.stringify({ session_id: A, hook_event_name: event, source: 'startup' }))
  // Nothing on stdout, which Claude Code would add to the session.
  expect(await hook('SessionStart')).toBe('')
  expect(todos.latestSession(p.id)?.socket).toBe('/socks/none')
  expect(await hook('SessionEnd')).toBe('')
  expect(todos.latestSession(p.id)?.socket).toBeNull()
  expect(await run('not json')).toBe('')
  // A ledger that cannot open: its home is a file.
  const file = join(tmp.make('nod-inbox-file-'), 'home')
  await Bun.write(file, '')
  const start = JSON.stringify({ session_id: A, hook_event_name: 'SessionStart' })
  expect(await run(start, file)).toBe('')

  const tell = Bun.spawn(['bun', cli, 'tell', 'p1', 'Hello', 'there'], { env, stdout: 'pipe' })
  expect(await tell.exited).toBe(0)
  expect(await new Response(tell.stdout).text()).toBe(
    'not sent yet: p1 has no session taking messages; it goes once one does\n',
  )
  expect(ledger.unsentNotices().map((n) => n.note)).toEqual(['nod tell from human:\nHello there'])
}, 15_000)

inboxTest(
  "notify writes one line into the session's socket, a user message to its id, as Claude Code reads it; with no socket there it waits, and the end it tells of stands",
  async () => {
    const { home, ledger, todos, p, task, turn } = setup()
    const socket = join(tmp.make('nod-inbox-sock-', socketsParent()), 's')
    todos.addSession(p.id, A, '/work/one')
    todos.setSocket(A, socket)
    const id = task('Ship it')
    turn(id, 'succeeded', 'Shipped')
    ledger.succeed(id)
    const ref = { id, brief: 'Ship it', issue: null }

    // The session ended without saying so: its socket file is gone.
    await notify(home, { event: 'succeeded', task: ref, summary: 'Shipped' })
    expect(ledger.get(id).status).toBe('succeeded')
    expect(ledger.unsentNotices()).toHaveLength(1)
    expect(todos.latestSession(p.id)?.socket).toBeNull()

    const server = await inboxServer(socket)
    try {
      await onInbox(ledger, { session_id: A, hook_event_name: 'SessionStart' }, socket)
      await server.received(1)
      expect(server.lines).toEqual([
        {
          type: 'user',
          session_id: A,
          message: {
            role: 'user',
            content:
              'nod, project p1 Release: a notice\n\ntask n1 t1 succeeded, attempt 1: Shipped\nnext: nod show n1, then send its result out',
          },
        },
      ])
      expect(ledger.unsentNotices()).toEqual([])
      // The next end goes as notify runs, and nothing sent goes again.
      const broke = task('Break it')
      ledger.error(broke, 'it broke')
      await notify(home, { event: 'error', task: { ...ref, id: broke }, error: 'it broke' })
      await server.received(2)
      expect(server.lines).toHaveLength(2)
      expect(server.lines[1]).toMatchObject({
        session_id: A,
        message: { content: expect.stringContaining('task n2 t2 error: it broke') },
      })
    } finally {
      await server.close()
    }
  },
)

inboxTest(
  "a nod command in a project session its hooks never told nod of writes the socket Claude Code exported to it, and what waited goes there; another session's command changes nothing",
  async () => {
    const { home, ledger, todos, p, task, turn } = setup()
    const socket = join(tmp.make('nod-inbox-cmd-', socketsParent()), 's')
    todos.addSession(p.id, A, '/work/one')
    const id = task('Ship it')
    turn(id, 'succeeded', 'Shipped')
    ledger.succeed(id)
    const {
      CLAUDECODE: _,
      CLAUDE_CODE_SESSION_ID: __,
      CLAUDE_CODE_MESSAGING_SOCKET: ___,
      NOD_TASK: ____,
      NOD_ACTOR: _____,
      ...shell
    } = process.env
    // `nod project`, as a Claude session runs it from its Bash.
    const nod = async (session: string, inbox?: string) => {
      const proc = Bun.spawn(['bun', cli, 'project'], {
        env: {
          ...shell,
          NOD_HOME: home,
          CLAUDECODE: '1',
          CLAUDE_CODE_SESSION_ID: session,
          ...(inbox === undefined ? {} : { CLAUDE_CODE_MESSAGING_SOCKET: inbox }),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      return { code, out, err }
    }

    const server = await inboxServer(socket)
    try {
      expect(await nod(C, socket)).toEqual({ code: 0, out: expect.any(String), err: '' })
      expect(todos.latestSession(p.id)?.socket).toBeNull()
      expect(ledger.unsentNotices()).toHaveLength(1)

      expect(await nod(A, socket)).toEqual({
        code: 0,
        out: expect.stringContaining('Release'),
        err: '',
      })
      expect(todos.latestSession(p.id)?.socket).toBe(socket)
      await server.received(1)
      expect(server.lines).toEqual([
        {
          type: 'user',
          session_id: A,
          message: {
            role: 'user',
            content:
              'nod, project p1 Release: a notice\n\ntask n1 t1 succeeded, attempt 1: Shipped\nnext: nod show n1, then send its result out',
          },
        },
      ])
      expect(ledger.unsentNotices()).toEqual([])
    } finally {
      await server.close()
    }

    // A newer session of the project with no socket says on stderr that it hears nothing.
    todos.addSession(p.id, B, '/work/two')
    const deaf = await nod(B)
    expect(deaf.code).toBe(0)
    expect(deaf.err).toBe(
      'nod: this session of p1 hears nothing from nod: Claude Code gave it no inbox socket (CLAUDE_CODE_MESSAGING_SOCKET); nod open p1 opens it again\n',
    )
  },
  15_000,
)

test("a Claude session that sets a project's work going hears, once per project and command, that the project's latest session cannot hear it either; a shell, that latest session, one that hears, and work in no project hear nothing", async () => {
  const { home, ledger, todos, p, q, task, send } = setup()
  // What C, a session nod open did not open, added; task() adds as another session did.
  const ofC = (text: string, project: number | null): number =>
    todos.delegateNew({ ...brief(text), rootSession: C }, project, 'human')
  const mine = ofC('Mine', p.id)
  const theirs = task('Theirs')
  const loose = ofC('In no project', null)
  const health = ofC('Health work', q.id)
  const deaf = (project: string, why: string, watch = 'nod watch --mine', it = 'it again') =>
    `nod: ${project}'s session hears nothing from nod (${why}), so the decisions and ends of this work wait unheard; run ${watch} here, or nod open ${project} opens ${it}`

  // No session of p1 yet: one line for its two tasks; --mine would leave out another's task.
  const never = 'nod open never opened one'
  expect(unheardWork(ledger, C, [mine, mine])).toEqual([deaf('p1', never, undefined, 'one')])
  expect(unheardWork(ledger, C, [mine, theirs])).toEqual([deaf('p1', never, 'nod watch', 'one')])
  expect(unheardWork(ledger, C, [loose])).toEqual([])
  expect(unheardWork(ledger, null, [mine, health])).toEqual([])

  // p1's session ended (no socket), ended without its hook (socket file gone), and runs.
  todos.addSession(p.id, A, '/work/one')
  expect(unheardWork(ledger, C, [mine, loose, health])).toEqual([
    deaf('p1', 'it takes no messages now'),
    deaf('p2', never, undefined, 'one'),
  ])
  const socket = join(home, 'a.sock')
  todos.setSocket(A, socket)
  expect(unheardWork(ledger, C, [mine])).toEqual([deaf('p1', 'its inbox socket is gone')])
  writeFileSync(socket, '')
  expect(unheardWork(ledger, C, [mine, theirs])).toEqual([])
  // Once per command: a project told of already is not told of again.
  const once = new Set<number>()
  expect(unheardWork(ledger, C, [health], once)).toHaveLength(1)
  expect(unheardWork(ledger, C, [health, mine], once)).toEqual([])

  // /clear in p1's session, one with no hooks: its new ID C brings A's socket, and onCommand,
  // which runs first, takes it from A and tells of p1, so the command tells of p1 no more.
  const cleared = new Set<number>()
  expect(await onCommand(ledger, C, socket, send, cleared)).toStartWith(
    "nod: p1's session took messages at this session's inbox socket",
  )
  expect(unheardWork(ledger, C, [mine], cleared)).toEqual([])
  expect(unheardWork(ledger, C, [mine])).toEqual([deaf('p1', 'it takes no messages now')])

  // The latest session itself hears nothing here, as onCommand speaks for it; an older one of the
  // project does, and has all the project's tasks as its own.
  todos.addSession(p.id, B, '/work/two')
  expect(unheardWork(ledger, B, [mine])).toEqual([])
  expect(unheardWork(ledger, A, [theirs])).toEqual([deaf('p1', 'it takes no messages now')])
  // In a command, onCommand tells that older session of p1 first, and that is all it hears of p1.
  const older = new Set<number>()
  expect(await onCommand(ledger, A, undefined, send, older)).toStartWith(
    'nod: this session of p1 hears nothing from nod',
  )
  expect(unheardWork(ledger, A, [theirs], older)).toEqual([])
})

test('nod add, tell and an answer run in a Claude session say on stderr that no session of the project hears the work; in a shell, or once the project session runs, they say nothing', () => {
  const { home, ledger, todos, p, task } = setup()
  const {
    CLAUDECODE: _,
    CLAUDE_CODE_SESSION_ID: __,
    CLAUDE_CODE_MESSAGING_SOCKET: ___,
    NOD_TASK: ____,
    NOD_ACTOR: _____,
    ...shell
  } = process.env
  const nod = (session: string | null, ...args: string[]): string => {
    const claude = session === null ? {} : { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session }
    const r = Bun.spawnSync(['bun', cli, ...args], { env: { ...shell, NOD_HOME: home, ...claude } })
    return r.stderr.toString()
  }
  // Each waits on a task that never starts here, so no worker runs, and tell and the answer stop
  // once the warning is out: the task has not started.
  const never = ledger.add(brief('never starts'))
  const added = nod(C, 'add', 'Ship it', '--project', 'p1', '--after', `n${never}`)
  const id = ledger.list().find((t) => t.brief === 'Ship it')?.id ?? 0
  const ask = (taskId: number, question: string, reason: 'question' | 'land' = 'question') => {
    const attemptId = ledger.startAttempt({
      taskId,
      kind: 'start',
      decisionId: null,
      sessionId: 's',
      prompt: 'p',
    })
    return ledger.ask(taskId, attemptId, reason, question)
  }
  const d = ask(id, 'Which way?')
  // An answer that only closes a decision left open on a task that succeeded sets nothing going.
  const done = task('Done already')
  const stale = ask(done, 'Still?')
  ledger.succeed(done)
  // No to landing again only stops landing it.
  const landing = ask(task('Land it'), 'Try landing again?', 'land')
  const line =
    "nod: p1's session hears nothing from nod (nod open never opened one), so the decisions and ends of this work wait unheard; run nod watch --mine here, or nod open p1 opens one\n"
  expect(added).toContain(line)
  expect(nod(C, 'tell', `n${id}`, 'and the docs')).toContain(line)
  expect(nod(B, 'tell', `n${id}`, 'and the docs')).toContain(line.replace('--mine ', ''))
  expect(nod(C, `d${d}`, 'left')).toContain(line)
  expect(nod(C, `d${stale}`, 'never mind')).not.toContain('hears nothing')
  expect(nod(C, `d${landing}`, 'no')).not.toContain('hears nothing')
  expect(ledger.decision(landing).answer).toBe('no')
  // A restart that finds no terminal to start again sets nothing going either.
  expect(nod(C, 'restart', `n${id}`)).not.toContain('hears nothing')
  expect(nod(null, 'tell', `n${id}`, 'and the docs')).not.toContain('hears nothing')

  todos.addSession(p.id, A, '/work/one')
  const socket = join(home, 'a.sock')
  todos.setSocket(A, socket)
  writeFileSync(socket, '')
  expect(nod(C, 'tell', `n${id}`, 'and the docs')).not.toContain('hears nothing')
}, 30_000)
