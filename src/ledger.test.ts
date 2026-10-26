import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger, MIGRATIONS } from './ledger'
import { Todos } from './todos'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const freshHome = (): string => tmp.make('nod-ledger-')

test('reopening a ledger keeps its data and does not re-run migrations', () => {
  const home = freshHome()
  const id = new Ledger(home).add({
    brief: 'keep me',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const reopened = new Ledger(home)
  expect(reopened.get(id).brief).toBe('keep me')
  expect(reopened.db.query('pragma user_version').get()).toEqual({ user_version: 23 })
})

test('v18 leaves the tasks before it without a root session', () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 17)) old.exec(sql)
  old.exec(
    "pragma user_version = 17; insert into tasks (id, brief, created_at) values (1, 'x', 'at')",
  )
  old.close()

  const ledger = new Ledger(home)
  expect(ledger.get(1)).toMatchObject({ brief: 'x', rootSession: null })
  expect(ledger.db.query('pragma user_version').get()).toEqual({ user_version: 23 })
})

test('v23 gives a ledger of v22 project sessions, none yet, and leaves its projects as they were', () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 22)) old.exec(sql)
  old.exec(`pragma user_version = 22;
    insert into projects (id, title, status, created_at, status_at)
      values (1, 'Release', 'active', 'at', 'at');`)
  old.close()

  const todos = new Todos(new Ledger(home))
  expect(todos.project(1)).toMatchObject({ title: 'Release', status: 'active' })
  expect(todos.latestSession(1)).toBeNull()
  const session = todos.addSession(1, 'cccc3333-0000-4000-8000-00000000000c', '/work/release')
  expect(todos.latestSession(1)).toEqual(session)
})

test("v21 counts the turns and messages before it as the person's, from no task", () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 20)) old.exec(sql)
  old.exec(`pragma user_version = 20;
    insert into tasks (id, brief, created_at) values (1, 'x', 'at'), (2, 'y', 'at');
    insert into attempts (id, task_id, kind, session_id, prompt, started_at)
      values (1, 1, 'followup', 's', 'from the person', 'at');
    insert into messages (task_id, attempt_id, text, created_at) values (1, 1, 'also', 'at');`)
  old.close()

  const ledger = new Ledger(home)
  expect(ledger.attempts(1)).toMatchObject([{ prompt: 'from the person', fromTask: null }])
  expect(ledger.messages(1)).toMatchObject([{ text: 'also', fromTask: null }])
  expect(ledger.tellsBetween(1, 2)).toBe(0)
})

test('the messages two tasks sent each other count both ways, in turns and within them, and nothing else does', () => {
  const ledger = new Ledger(freshHome())
  const [a, b, c] = ['a', 'b', 'c'].map((brief) =>
    ledger.add({
      brief,
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    }),
  ) as [number, number, number]
  const turn = (taskId: number, fromTask: number | null): number =>
    ledger.startAttempt({
      taskId,
      kind: 'followup',
      decisionId: null,
      sessionId: `s${taskId}`,
      prompt: 'p',
      fromTask,
    })
  turn(b, a) // a told b, starting a turn
  const inB = turn(b, null) // the person told b
  ledger.addMessage(b, inB, 'more', a) // a told b again, into that turn
  ledger.addMessage(b, inB, 'mine') // and so did the person
  turn(a, b) // b answered a
  turn(c, a) // a told another task
  expect(ledger.tellsBetween(a, b)).toBe(3)
  expect(ledger.tellsBetween(b, a)).toBe(3)
  expect(ledger.tellsBetween(a, c)).toBe(1)
  expect(ledger.tellsBetween(b, c)).toBe(0)
  expect(ledger.attempts(b).map((x) => x.fromTask)).toEqual([a, null])
  expect(ledger.messages(b).map((m) => m.fromTask)).toEqual([a, null])
})

test('a task keeps the session that added it, and its retrospective takes it; a trigger task has none', () => {
  const ledger = new Ledger(freshHome())
  const task = (rootSession?: string | null) =>
    ledger.add({
      brief: 't',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
      rootSession,
    })
  const id = task('root-a')
  expect(ledger.get(id).rootSession).toBe('root-a')
  expect(ledger.get(ledger.addRetro(ledger.get(id), 'look back')).rootSession).toBe('root-a')
  expect(ledger.get(task(null)).rootSession).toBeNull()
  expect(ledger.get(task()).rootSession).toBeNull()

  const triggerId = ledger.addTrigger({
    cron: '* * * * *',
    brief: 'look',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    source: null,
    seen: [],
  })
  const fromTrigger = ledger.addTriggerTask(ledger.trigger(triggerId), null, 'look')
  expect(ledger.get(fromTrigger).rootSession).toBeNull()
})

// A ledger as v16 left it, with retrospectives (id, rule, outcome) of tasks of the same id.
function v16Home(retros: [number, string, string][]): string {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 16)) old.exec(sql)
  old.exec('pragma user_version = 16')
  for (const [id, rule, outcome] of retros) {
    old.query("insert into tasks (id, brief, created_at) values ($id, 'x', 'at')").run({ id })
    old
      .query(
        `insert into retros (id, of_task_id, rule, outcome, created_at)
         values ($id, $id, $rule, $outcome, 'at')`,
      )
      .run({ id, rule, outcome })
  }
  old.close()
  return home
}

test('v17 moves rules.md into the ledger, each line tied to the added retrospective that proposed it, and renames the file', () => {
  const home = v16Home([
    [1, 'do A', 'added'],
    [2, 'do B', 'declined'],
    [3, 'do C', 'added'],
  ])
  const file = '- do A\n- do C, reworded by hand\n\n- do B\nno dash\n'
  writeFileSync(join(home, 'rules.md'), file)

  const ledger = new Ledger(home)
  expect(ledger.rules().map((r) => [r.text, r.retroId, r.state])).toEqual([
    ['do A', 1, 'on'],
    ['do C, reworded by hand', null, 'on'],
    ['do B', null, 'on'],
    ['no dash', null, 'on'],
  ])
  const actors = ledger.db.query<{ actor: string }, []>('select actor from rule_changes').all()
  expect(new Set(actors.map((a) => a.actor))).toEqual(new Set(['nod']))
  expect(existsSync(join(home, 'rules.md'))).toBe(false)
  expect(readFileSync(join(home, 'rules.md.imported'), 'utf8')).toBe(file)

  // From then on nod neither reads nor moves the file, whatever a person writes to it.
  writeFileSync(join(home, 'rules.md'), '- written later\n')
  expect(new Ledger(home).rules()).toHaveLength(4)
  expect(existsSync(join(home, 'rules.md'))).toBe(true)
})

test('v17 without rules.md leaves the rules empty and makes no file', () => {
  const home = v16Home([[1, 'do A', 'added']])
  expect(new Ledger(home).rules()).toEqual([])
  expect(existsSync(join(home, 'rules.md.imported'))).toBe(false)
})

test('a rule changes only when told something new, records who changed what, and is one line', () => {
  const ledger = new Ledger(freshHome())
  const { id } = ledger.addRule('keep it short', null, 'human')
  ledger.setRule(id, { text: 'keep it short', state: 'on' }, 'human')
  ledger.setRule(id, { text: 'keep it shorter' }, 'claude:ab12')
  ledger.setRule(id, { state: 'off' }, 'human')
  expect(ledger.rule(id)).toMatchObject({ text: 'keep it shorter', state: 'off', retroId: null })
  const changes = ledger.db
    .query<{ actor: string; change: string }, []>('select actor, change from rule_changes')
    .all()
    .map((c) => [c.actor, JSON.parse(c.change)])
  expect(changes).toEqual([
    ['human', { text: [null, 'keep it short'], state: [null, 'on'] }],
    ['claude:ab12', { text: ['keep it short', 'keep it shorter'] }],
    ['human', { state: ['on', 'off'] }],
  ])
  expect(() => ledger.addRule(' ', null, 'human')).toThrow('empty rule')
  expect(() => ledger.setRule(id, { text: 'two\nlines' }, 'human')).toThrow('one line')
  expect(() => ledger.setRule(9, { state: 'off' }, 'human')).toThrow('rule 9 not found')
})

test("a rule is edited once its words differ from its retrospective's proposal; one written by hand never is", () => {
  const ledger = new Ledger(freshHome())
  const of = ledger.add({
    brief: 'x',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const retroId = ledger.get(ledger.addRetro(ledger.get(of), 'look back')).retroId ?? 0
  ledger.proposeRule(retroId, 'check first')
  const proposed = ledger.addRule('check first', retroId, 'human')
  const byHand = ledger.addRule('keep it short', null, 'human')
  ledger.setRule(byHand.id, { text: 'keep it shorter' }, 'human')
  const edited = (): boolean[] => ledger.rulesNow().map((r) => r.edited)
  expect(edited()).toEqual([false, false])
  ledger.setRule(proposed.id, { text: 'check first, always' }, 'human')
  expect(edited()).toEqual([true, false])
  ledger.setRule(proposed.id, { text: 'check first', state: 'off' }, 'human')
  expect(ledger.rulesNow()[0]).toMatchObject({ state: 'off', edited: false })
})

test('v16 moves the retrospectives so far into their own table, with what became of each', () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 15)) old.exec(sql)
  old.exec('pragma user_version = 15')
  const at = '2026-01-01T00:00:00.000Z'
  const task = (id: number, retroOf: number | null, status: string): void => {
    old
      .query(
        `insert into tasks (id, brief, status, created_at, finished_at, retro_of)
         values ($id, 'x', $status, $at, $at, $retroOf)`,
      )
      .run({ id, status, at, retroOf })
  }
  const rule = (taskId: number, summary: string, answer: string): void => {
    const attempt = old
      .query<{ id: number }, { taskId: number; summary: string; at: string }>(
        `insert into attempts (task_id, kind, session_id, prompt, summary, started_at)
         values ($taskId, 'start', 's', 'p', $summary, $at) returning id`,
      )
      .get({ taskId, summary, at })
    if (attempt === null) throw new Error('no attempt')
    const { id } = attempt
    old
      .query(
        `insert into decisions (task_id, attempt_id, reason, question, answer, created_at, answered_at)
         values ($taskId, $id, 'rule', 'q', $answer, $at, $at)`,
      )
      .run({ taskId, id, answer, at })
  }
  for (const id of [1, 2, 3, 4, 5, 11, 12]) task(id, null, 'succeeded')
  task(6, 1, 'succeeded')
  rule(6, 'do A', 'yes')
  task(7, 2, 'cancelled')
  rule(7, 'do B', '(dropped)')
  task(8, 3, 'succeeded')
  task(9, 4, 'cancelled')
  task(10, 5, 'error')
  // Yes as typed; and a rule turned down, then the retrospective resumed and its next rule added.
  task(13, 11, 'succeeded')
  rule(13, 'do C', 'y')
  task(14, 12, 'succeeded')
  rule(14, 'do D', '(dropped)')
  rule(14, 'do E', 'yes')
  // A second retrospective of the same task, started in a race.
  task(15, 11, 'cancelled')
  old.close()

  const ledger = new Ledger(home)
  expect(ledger.get(15).retroId).toBe(ledger.get(13).retroId)
  const moved = [6, 7, 8, 9, 10, 13, 14].map((id) => {
    const { retroId } = ledger.get(id)
    if (retroId === null) throw new Error(`task ${id} lost its retrospective`)
    const r = ledger.retro(retroId)
    return [r.ofTaskId, r.rule, r.outcome]
  })
  expect(moved).toEqual([
    [1, 'do A', 'added'],
    [2, 'do B', 'declined'],
    [3, null, 'none'],
    [4, null, 'dropped'],
    [5, null, null],
    [11, 'do C', 'added'],
    [12, 'do E', 'added'],
  ])
  expect(ledger.get(1).retroId).toBeNull()
  expect(ledger.retroFor(1)?.outcome).toBe('added')
})

test('a migration that fails part way is undone, and the ledger does not open', () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 15)) old.exec(sql)
  old.exec(`
    pragma user_version = 15;
    insert into tasks (id, brief, created_at) values (1, 'x', 'at');
    insert into tasks (id, brief, created_at, retro_of) values (2, 'x', 'at', 1);
  `)
  // Fails v16's last statement as it runs, not as it is prepared: exec of several statements would
  // go on past that without throwing.
  old.exec("create trigger boom before update on tasks begin select raise(abort, 'boom'); end")
  old.close()

  expect(() => new Ledger(home)).toThrow('boom')
  const after = new Database(join(home, 'nod.db'), { strict: true })
  expect(after.query('pragma user_version').get()).toEqual({ user_version: 15 })
  expect(after.query("select name from sqlite_master where name = 'retros'").get()).toBeNull()
})

test('links are kept once each, and only for a task that exists', () => {
  const ledger = new Ledger(freshHome())
  const id = ledger.add({
    brief: 't',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  ledger.link(id, ['https://example.com/pr/1'])
  ledger.link(id, ['https://example.com/pr/1', 'https://example.com/pr/2'])
  expect(ledger.links(id).sort()).toEqual(['https://example.com/pr/1', 'https://example.com/pr/2'])
  expect(() => ledger.link(id + 1, ['https://example.com/pr/3'])).toThrow('not found')
})

test('a task keeps its issue, and its retrospective and source items carry one', () => {
  const ledger = new Ledger(freshHome())
  const id = ledger.add({
    brief: 't',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: 'PROJ-1',
  })
  expect(ledger.get(id).issue).toBe('PROJ-1')
  expect(ledger.get(ledger.addRetro(ledger.get(id), 'look back')).issue).toBe('PROJ-1')

  const triggerId = ledger.addTrigger({
    cron: '* * * * *',
    brief: 'look',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    source: 'true',
    seen: [],
  })
  const fromItem = ledger.addItemTask(ledger.trigger(triggerId), 'PROJ-2', 'PROJ-2', 'look')
  expect(fromItem === null ? null : ledger.get(fromItem).issue).toBe('PROJ-2')
})

test('a decision can be answered once, and answering puts the task back to running', () => {
  const ledger = new Ledger(freshHome())
  const taskId = ledger.add({
    brief: 't',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const attemptId = ledger.startAttempt({
    taskId,
    kind: 'start',
    decisionId: null,
    sessionId: 's',
    prompt: 't',
  })
  const decisionId = ledger.ask(taskId, attemptId, 'question', 'ok?')
  expect(ledger.get(taskId).status).toBe('needs_decision')

  ledger.answer(decisionId, 'yes')
  expect(ledger.get(taskId).status).toBe('running')
  expect(() => ledger.answer(decisionId, 'again')).toThrow('already answered')
  expect(ledger.taskOfSession('s')).toBe(taskId)
  expect(ledger.taskOfSession('unknown')).toBeNull()
})

test('median decision wait uses answered decisions only', () => {
  const ledger = new Ledger(freshHome())
  const taskId = ledger.add({
    brief: 't',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const attemptId = ledger.startAttempt({
    taskId,
    kind: 'start',
    decisionId: null,
    sessionId: 's',
    prompt: 't',
  })
  for (const wait of [10, 30, 20]) {
    const id = ledger.ask(taskId, attemptId, 'question', 'q')
    ledger.db
      .query(
        `update decisions set answer = 'a', created_at = '2026-01-01T00:00:00.000Z',
         answered_at = $at where id = $id`,
      )
      .run({ id, at: `2026-01-01T00:00:${wait}.000Z` })
  }
  ledger.ask(taskId, attemptId, 'question', 'still open')
  expect(ledger.stats().decisions).toEqual({ total: 4, open: 1, medianWaitSecs: 20 })
})

const task = (ledger: Ledger, t: { repo?: string; after?: number[] } = {}): number =>
  ledger.add({
    brief: 't',
    repo: t.repo ?? null,
    branch: t.repo === undefined ? null : 'feat/t',
    checkCmd: null,
    model: null,
    after: t.after ?? [],
    triggerId: null,
    issue: null,
  })

test('a waiting task is claimed once, and only after every task it comes after has succeeded', () => {
  const ledger = new Ledger(freshHome())
  const a = task(ledger)
  const b = task(ledger)
  const c = task(ledger, { after: [a, b] })
  expect(ledger.claimReady()).toEqual([]) // a and b wait for nothing; `nod add` starts those
  ledger.succeed(a)
  expect(ledger.claimReady()).toEqual([])
  ledger.succeed(b)
  expect(ledger.claimReady()).toEqual([c])
  expect(ledger.claimReady()).toEqual([])
  expect(ledger.get(c).status).toBe('running')
})

test('dropping a task cancels every task waiting on it, all the way down', () => {
  const ledger = new Ledger(freshHome())
  const a = task(ledger)
  const attemptId = ledger.startAttempt({
    taskId: a,
    kind: 'start',
    decisionId: null,
    sessionId: 's',
    prompt: 't',
  })
  const decisionId = ledger.ask(a, attemptId, 'question', 'ok?')
  const b = task(ledger, { after: [a] })
  const c = task(ledger, { after: [b] })
  const unrelated = task(ledger)
  ledger.drop(decisionId)
  expect([a, b, c].map((id) => ledger.get(id).status)).toEqual([
    'cancelled',
    'cancelled',
    'cancelled',
  ])
  expect(ledger.get(c).error).toBe(`task #${b} it waits for was cancelled`)
  expect(ledger.get(unrelated).status).toBe('queued')
})

test('in one repo a task can come after only one task, and after only tasks that exist', () => {
  const ledger = new Ledger(freshHome())
  const a = task(ledger, { repo: '/r' })
  const b = task(ledger, { repo: '/r' })
  const elsewhere = task(ledger, { repo: '/s' })
  expect(() => task(ledger, { repo: '/r', after: [a, b] })).toThrow('chain them')
  expect(() => task(ledger, { after: [999] })).toThrow('task 999 not found')
  const c = task(ledger, { repo: '/r', after: [a, elsewhere] })
  expect(ledger.after(c).map((t) => t.id)).toEqual([a, elsewhere])
  expect(ledger.list().map((t) => t.id)).toEqual([a, b, elsewhere, c]) // failed adds left nothing
})

test('a transaction that reads before it writes waits while another process writes, instead of failing', async () => {
  const home = freshHome()
  const ledger = new Ledger(home)
  const a = task(ledger)
  // Another process (a Stop hook, say) holds the write lock, then commits a change.
  const writer = Bun.spawn(
    [
      'bun',
      '-e',
      `const db = new (require('bun:sqlite').Database)(${JSON.stringify(join(home, 'nod.db'))})
      db.exec('begin immediate')
      db.run("update tasks set brief = 'edited'")
      console.log('locked')
      await Bun.sleep(1000)
      db.exec('commit')`,
    ],
    { stdout: 'pipe' },
  )
  await writer.stdout.getReader().read()
  // add reads the task it comes after before it inserts.
  const b = task(ledger, { after: [a] })
  expect(await writer.exited).toBe(0)
  expect(ledger.after(b).map((t) => t.id)).toEqual([a])
  expect(ledger.get(a).brief).toBe('edited')
})

test('a trigger run is claimed once, a source item adds a task once, and removal hides it', () => {
  const ledger = new Ledger(freshHome())
  const id = ledger.addTrigger({
    cron: '* * * * *',
    brief: 'b',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    source: 'x',
    seen: ['old'],
  })
  expect(ledger.claimRun(id, null, '2026-10-06T00:01:00.000Z')).toBe(true)
  expect(ledger.claimRun(id, null, '2026-10-06T00:01:00.000Z')).toBe(false) // another tick won

  const trigger = ledger.trigger(id)
  expect(ledger.addItemTask(trigger, 'old', null, 'b')).toBeNull()
  const taskId = ledger.addItemTask(trigger, 'new', null, 'b')
  if (taskId === null) throw new Error('a new item added no task')
  expect(ledger.addItemTask(trigger, 'new', null, 'b')).toBeNull()
  expect(ledger.get(taskId).triggerId).toBe(id)

  ledger.removeTrigger(id)
  expect(ledger.triggers()).toEqual([])
  expect(() => ledger.removeTrigger(id)).toThrow(`trigger ${id} not found`)
})

test("a trigger's task in a repo works on the trigger's branch prefix and its own id", () => {
  const ledger = new Ledger(freshHome())
  const triggerId = ledger.addTrigger({
    cron: '* * * * *',
    brief: 'sweep',
    repo: '/repo',
    branch: 'chore/sweep',
    checkCmd: null,
    model: null,
    source: null,
    seen: [],
  })
  const id = ledger.addTriggerTask(ledger.trigger(triggerId), null, 'sweep')
  expect(ledger.get(id).branch).toBe(`chore/sweep/${id}`)
})
