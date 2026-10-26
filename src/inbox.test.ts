import { afterAll, expect, spyOn, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { inboxServer, inboxTest } from '../test/inbox-server'
import { tempDirs } from '../test/tmp'
import { onInbox, sendNotices, tellProject } from './inbox'
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
          'task #1 t1 succeeded, attempt 1: Added the export button\nnext: nod show 1, then send its result out',
          'task #2 t2 error, attempt 1: the worktree is gone\nnext: nod show 2 says why; settle with the person what to do',
          // Its decision was answered (dropped) before anything went, so only its end goes.
          'task #3 t3 cancelled, attempt 1: Drop me\nnext: tell the person (nod show 3)',
          'decision #2 question (task #4 t4: Pick a branch)\n  Which branch?\n  main or next\nnext: tell the person; nod 2 <their answer> answers it, nod drop 2 drops it',
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
    'nod, project p1 Release: a notice\n\ntask #2 t2 succeeded, attempt 2: Fixed the build\nnext: nod show 2, then send its result out',
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
    ['/socks/a', A, expect.stringContaining('task #1 t1 succeeded: Release work')],
    ['/socks/c', C, expect.stringContaining('task #2 t2 succeeded: Health work')],
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
  expect(sent[0]?.message.content).toContain('task #1 t1 succeeded: First')
  expect(sent[0]?.message.content).toContain('decision #1 permission (task #2 t2: Second)')

  // Once it ends it takes none, until it starts again, maybe elsewhere.
  await onInbox(ledger, { session_id: A, hook_event_name: 'SessionEnd' }, '/socks/a', send)
  expect(todos.latestSession(p.id)?.socket).toBeNull()
  ledger.error(task('Third'), 'boom')
  await sendNotices(ledger, send)
  expect(sent).toHaveLength(1)
  await start(A, '/socks/a2')
  expect(sent.map((s) => [s.socket, s.session_id])).toEqual([
    ['/socks/a', A],
    ['/socks/a2', A],
  ])
  expect(sent[1]?.message.content).toContain('task #3 t3 error: boom')
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
    expect.stringContaining('task #1 t1 succeeded: Ship it'),
  ])
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
  const { ledger, todos, p, task, sent, send } = setup()
  todos.addSession(p.id, A, '/work/one')
  todos.setSocket(A, '/socks/a')
  ledger.succeed(task('Once'))
  // Another process sends while this one's line is on its way.
  await sendNotices(ledger, async (socket, line) => {
    await sendNotices(ledger, send)
    await send(socket, line)
  })
  expect(sent).toHaveLength(1)
  expect(sent[0]?.message.content).toContain('task #1 t1 succeeded: Once')
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
  const hook = async (event: string, socket: string): Promise<string> => {
    const proc = Bun.spawn(['bun', cli, 'hook', 'inbox'], {
      env: { ...env, CLAUDE_CODE_MESSAGING_SOCKET: socket },
      stdin: new Blob([
        JSON.stringify({ session_id: A, hook_event_name: event, source: 'startup' }),
      ]),
      stdout: 'pipe',
    })
    expect(await proc.exited).toBe(0)
    return new Response(proc.stdout).text()
  }
  // Nothing on stdout, which Claude Code would add to the session.
  expect(await hook('SessionStart', '/socks/none')).toBe('')
  expect(todos.latestSession(p.id)?.socket).toBe('/socks/none')
  expect(await hook('SessionEnd', '/socks/none')).toBe('')
  expect(todos.latestSession(p.id)?.socket).toBeNull()

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
    const socket = join(tmp.make('nod-inbox-sock-'), 's')
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
              'nod, project p1 Release: a notice\n\ntask #1 t1 succeeded, attempt 1: Shipped\nnext: nod show 1, then send its result out',
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
        message: { content: expect.stringContaining('task #2 t2 error: it broke') },
      })
    } finally {
      await server.close()
    }
  },
)
