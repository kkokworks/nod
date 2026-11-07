import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger, MIGRATIONS, RETRO_STATUS, type RetroOutcome, type TaskStatus } from './ledger'
import { hadTrouble } from './rules'
import { SESSION_ROLES, Todos } from './todos'
import { changeText } from './view'

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
    issue: null,
  })
  const reopened = new Ledger(home)
  expect(reopened.get(id).brief).toBe('keep me')
  expect(reopened.db.query('pragma user_version').get()).toEqual({ user_version: 33 })
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
  expect(ledger.db.query('pragma user_version').get()).toEqual({ user_version: 33 })
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

test('v29 moves the project sessions of a v28 ledger to sessions under their ids, so each latest session and each notice’s session stays', () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 28)) old.exec(sql)
  old.exec(`pragma user_version = 28;
    insert into projects (id, title, status, created_at, status_at)
      values (1, 'Release', 'active', 'at', 'at'), (2, 'Health', 'active', 'at', 'at');
    insert into project_sessions (id, session_id, project_id, cwd, created_at, socket)
      values (3, 'key-a', 1, '/work/a', 'at-a', null),
             (7, 'key-b', 2, '/work/b', 'at-b', '/socks/b'),
             (9, 'key-c', 1, '/work/c', 'at-c', '/socks/c');
    insert into notices (id, project_id, event, note, created_at, session_id, sent_at)
      values (1, 1, 'tell', 'to a', 'at', 'key-a', 'sent-1'),
             (2, 2, 'tell', 'to b', 'at', 'key-b', 'sent-2'),
             (3, 1, 'tell', 'to none', 'at', null, 'sent-3'),
             (4, 1, 'tell', 'unsent', 'at', null, null),
             (5, 1, 'tell', 'to no row', 'at', 'key-gone', 'sent-5');`)
  old.close()

  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  expect(ledger.db.query('pragma user_version').get()).toEqual({ user_version: 33 })
  expect(ledger.db.query('pragma foreign_key_check').all()).toEqual([])
  expect(todos.latestSession(1)).toEqual({
    id: 9,
    sessionKey: 'key-c',
    role: 'project',
    name: 'Release',
    cwd: '/work/c',
    socket: '/socks/c',
    createdAt: 'at-c',
  })
  expect(todos.latestSession(2)).toMatchObject({ id: 7, sessionKey: 'key-b', name: 'Health' })
  expect(todos.sessionPlace('key-a')).toMatchObject({
    session: { id: 3, cwd: '/work/a', socket: null, createdAt: 'at-a' },
    project: { id: 1 },
    latest: false,
  })
  expect(todos.sessionPlace('key-c')?.latest).toBe(true)
  // Ids go on from the highest, so the next session opened is its project's latest.
  expect(todos.addSession(2, 'key-d', '/work/d').id).toBe(10)
  expect(todos.latestSession(2)?.sessionKey).toBe('key-d')

  expect(ledger.notice(1)).toMatchObject({ sessionId: 3, sentAt: 'sent-1', note: 'to a' })
  expect(ledger.notice(2)).toMatchObject({ sessionId: 7, sentAt: 'sent-2', note: 'to b' })
  expect(ledger.notice(3)).toMatchObject({ sessionId: null, sentAt: 'sent-3' })
  expect(ledger.notice(1)).not.toHaveProperty('sessionKey')
  expect(ledger.unsentNotices()).toMatchObject([{ id: 4, sessionId: null, note: 'unsent' }])
  // A session no row names: the notice stays sent. v29 kept the ID it held; v33 drops it.
  expect(ledger.notice(5)).toMatchObject({ sessionId: null, sentAt: 'sent-5', note: 'to no row' })
  // A notice's session is a row of sessions now.
  expect(() => ledger.claimNotices([4], 99)).toThrow('FOREIGN KEY constraint failed')
  expect(ledger.claimNotices([4], 9).ids).toEqual([4])
})

test('v30 leaves the description of a v29 ledger’s projects empty and all else as it was', () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 29)) old.exec(sql)
  old.exec(`pragma user_version = 29;
    insert into projects (id, title, outcome, status, created_at, status_at)
      values (1, 'Release', 'Shipped', 'someday', 'made', 'moved');`)
  old.close()

  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  expect(ledger.db.query('pragma user_version').get()).toEqual({ user_version: 33 })
  expect(todos.project(1)).toEqual({
    id: 1,
    title: 'Release',
    outcome: 'Shipped',
    description: null,
    status: 'someday',
    createdAt: 'made',
    statusAt: 'moved',
  })
  expect(todos.setProject(1, { description: 'What ships' }, 'human').description).toBe('What ships')
})

test('v31 leaves a v30 ledger’s projects as they were, with no orchestrator, and holds one to a project', () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 30)) old.exec(sql)
  old.exec(`pragma user_version = 30;
    insert into projects (id, title, outcome, description, status, created_at, status_at)
      values (1, 'Release', 'Shipped', 'What ships', 'someday', 'made', 'moved');
    insert into sessions (id, session_key, role, name, cwd, created_at)
      values (2, 'key-a', 'orchestrator', 'north', '/work/a', 'at');`)
  old.close()

  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  expect(ledger.db.query('pragma user_version').get()).toEqual({ user_version: 33 })
  expect(ledger.db.query('select * from project_orchestrators').all()).toEqual([])
  expect(todos.project(1)).toEqual({
    id: 1,
    title: 'Release',
    outcome: 'Shipped',
    description: 'What ships',
    status: 'someday',
    createdAt: 'made',
    statusAt: 'moved',
  })
  expect(todos.orchestratorOf(1)).toBeNull()

  todos.setProject(1, { orchestrator: 'north' }, 'human')
  expect(ledger.db.query('select * from project_orchestrators').all()).toEqual([
    { project_id: 1, orchestrator: 'north' },
  ])
  const add = (id: number) =>
    ledger.db.exec(`insert into project_orchestrators values (${id}, 'north')`)
  expect(() => add(1)).toThrow('UNIQUE constraint failed')
  expect(() => add(9)).toThrow('FOREIGN KEY constraint failed')
})

// A ledger as v31 left it, with tasks 1 and 2, a todo and a rule, and what `rows` inserts.
function v31Home(rows: string): string {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 31)) old.exec(sql)
  old.exec(`pragma user_version = 31;
    insert into tasks (id, brief, created_at) values (1, 'first', 'at'), (2, 'second', 'at');
    insert into todos (id, title, source, created_at, status_at) values (1, 'Mine', 'cli', 'at', 'at');
    insert into rules (id, text, state, created_at, changed_at) values (1, 'be brief', 'on', 'at', 'at');
    ${rows}`)
  old.close()
  return home
}

// What the v32 ledger holds besides the triggers: the tables, each with its row count, and the
// columns of tasks.
function shape(ledger: Ledger): { tables: Record<string, number>; taskColumns: string[] } {
  const names = ledger.db
    .query<{ name: string }, []>(
      "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all()
    .map((t) => t.name)
  const count = (name: string): number =>
    ledger.db.query<{ n: number }, []>(`select count(*) n from ${name}`).get()?.n ?? -1
  const taskColumns = ledger.db
    .query<{ name: string }, [string]>('select name from pragma_table_info(?)')
    .all('tasks')
    .map((c) => c.name)
  return { tables: Object.fromEntries(names.map((n) => [n, count(n)])), taskColumns }
}

test('v32 drops the triggers of a v31 ledger that had none, and keeps every other row', () => {
  const home = v31Home('')
  const before = new Database(join(home, 'nod.db'), { readonly: true })
  const tables = Object.fromEntries(
    before
      .query<{ name: string }, []>(
        "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%'",
      )
      .all()
      // and the table v33 drops
      .filter((t) => !['triggers', 'trigger_items', 'unmatched_notice_sessions'].includes(t.name))
      .map((t) => [
        t.name,
        before.query<{ n: number }, []>(`select count(*) n from ${t.name}`).get()?.n ?? -1,
      ]),
  )
  before.close()

  const ledger = new Ledger(home)
  expect(ledger.db.query('pragma user_version').get()).toEqual({ user_version: 33 })
  const after = shape(ledger)
  expect(after.tables).toEqual(tables)
  expect(after.taskColumns).not.toContain('trigger_id')
  expect(ledger.get(1).brief).toBe('first')
  expect(existsSync(join(home, 'triggers.json'))).toBe(false)
  expect(ledger.db.query('pragma foreign_key_check').all()).toEqual([])
})

test('v32 keeps what a v31 ledger held of triggers in triggers.json, and puts those not removed in the inbox', () => {
  const home = v31Home(`
    insert into triggers (id, cron, brief, repo, branch, check_cmd, model, source, last_run_at, created_at)
      values (1, '0 9 * * MON-FRI', 'triage the new issues', '/repo', 'chore/triage', 'make check',
        'opus', 'list-issues', 'ran', 'made');
    insert into triggers (id, cron, brief, source, created_at, removed_at)
      values (2, '0 18 * * *', 'old digest', null, 'made', 'gone');
    insert into triggers (id, cron, brief, created_at) values (3, '*/5 * * * *', 'tidy up', 'made');
    insert into trigger_items (trigger_id, key, task_id, seen_at) values (1, 'PROJ-1', 1, 'seen'),
      (1, 'PROJ-2', null, 'seen');
    update tasks set trigger_id = 1 where id = 1;
    update tasks set trigger_id = 2 where id = 2;`)
  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  expect(shape(ledger).taskColumns).not.toContain('trigger_id')
  expect(ledger.list().map((t) => t.brief)).toEqual(['first', 'second'])
  expect(ledger.rules().map((r) => r.text)).toEqual(['be brief'])

  const path = join(home, 'triggers.json')
  expect(statSync(path).mode & 0o777).toBe(0o600) // a source command may hold a token
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  expect(saved.triggers.map((t: { id: number }) => t.id)).toEqual([1, 2, 3])
  expect(saved.triggers[0]).toEqual({
    id: 1,
    cron: '0 9 * * MON-FRI',
    brief: 'triage the new issues',
    repo: '/repo',
    check_cmd: 'make check',
    model: 'opus',
    source: 'list-issues',
    last_run_at: 'ran',
    last_error: null,
    created_at: 'made',
    removed_at: null,
    branch: 'chore/triage',
  })
  expect(saved.items).toEqual([
    { trigger_id: 1, key: 'PROJ-1', task_id: 1, seen_at: 'seen' },
    { trigger_id: 1, key: 'PROJ-2', task_id: null, seen_at: 'seen' },
  ])
  expect(saved.tasks).toEqual([
    { id: 1, trigger_id: 1 },
    { id: 2, trigger_id: 2 },
  ])

  // One todo for the two that ran until now; the one removed before is only in the file.
  const inbox = todos.list({
    statuses: ['inbox'],
    projectId: null,
    hideSomedayProjects: false,
    day: null,
  })
  expect(inbox.map((t) => t.title)).toEqual([
    'Mine',
    'Move 2 trigger(s) to cron or launchd: nod no longer runs them',
  ])
  const todo = inbox[1]
  if (todo === undefined) throw new Error('no todo')
  expect(todo.source).toBe('nod')
  expect(todo.notes).toBe(
    [
      'nod no longer runs triggers. These ran until now:',
      'c1 `0 9 * * MON-FRI`: triage the new issues',
      '  source: list-issues',
      '  repo: /repo',
      '  branch prefix: chore/triage',
      '  check: make check',
      '  model: opus',
      'c3 `*/5 * * * *`: tidy up',
      'Instead: at a set time, run nod add from cron or launchd; to take each item a command' +
        ' lists once, nod in --source <name> --key <key>.',
      `Every trigger row, the items their sources listed and the tasks they added: ${path}`,
    ].join('\n'),
  )
  expect(todos.changes(todo.id)).toEqual([
    {
      actor: 'nod',
      change: {
        title: [null, todo.title],
        notes: [null, todo.notes],
        status: [null, 'inbox'],
        source: [null, 'nod'],
      },
      at: todo.createdAt,
    },
  ])
})

test('v32 keeps the triggers of a v31 ledger that were all removed in triggers.json only', () => {
  const home = v31Home(`
    insert into triggers (id, cron, brief, created_at, removed_at) values (1, '0 9 * * *', 'b', 'made', 'gone');`)
  const ledger = new Ledger(home)
  expect(JSON.parse(readFileSync(join(home, 'triggers.json'), 'utf8')).triggers).toHaveLength(1)
  expect(new Todos(ledger).get(1).title).toBe('Mine')
  expect(ledger.db.query('select count(*) n from todos').get()).toEqual({ n: 1 })
})

test('v32 leaves a v31 ledger as it was when triggers.json cannot be written', () => {
  const home = v31Home(`
    insert into triggers (id, cron, brief, created_at) values (1, '0 9 * * *', 'b', 'made');`)
  mkdirSync(join(home, 'triggers.json')) // a folder where the file goes
  expect(() => new Ledger(home)).toThrow(
    `v32 keeps the triggers in ${join(home, 'triggers.json')} before it drops them, and could not: `,
  )
  const old = new Database(join(home, 'nod.db'), { readonly: true })
  expect(old.query('pragma user_version').get()).toEqual({ user_version: 31 })
  expect(old.query('select count(*) n from triggers').get()).toEqual({ n: 1 })
  expect(old.query('select count(*) n from todos').get()).toEqual({ n: 1 })
  old.close()
})

// A ledger as v32 left it, with two tasks, a turn of the first, a project, a todo, a rule and a
// sent notice, and what `rows` inserts.
function v32Home(rows: string): string {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 32)) old.exec(sql)
  old.exec(`pragma user_version = 32;
    insert into tasks (id, brief, created_at) values (1, 'first', 'at'), (2, 'second', 'at');
    insert into attempts (id, task_id, kind, session_id, prompt, outcome, report, started_at)
      values (1, 1, 'start', 's', 'p', 'succeeded', 'NOD: done | shipped', 'at');
    insert into projects (id, title, status, created_at, status_at)
      values (1, 'Release', 'active', 'at', 'at');
    insert into todos (id, title, source, created_at, status_at) values (1, 'Mine', 'cli', 'at', 'at');
    insert into rules (id, text, state, created_at, changed_at) values (1, 'be brief', 'on', 'at', 'at');
    insert into notices (id, project_id, event, note, created_at, sent_at)
      values (1, 1, 'tell', 'hi', 'at', 'sent');
    ${rows}`)
  old.close()
  return home
}

const columns = (ledger: Ledger, table: string): string[] =>
  ledger.db
    .query<{ name: string }, [string]>('select name from pragma_table_info(?)')
    .all(table)
    .map((c) => c.name)

test('v33 drops the unused columns and table of a v32 ledger that held nothing in them, and keeps every other row', () => {
  const home = v32Home('')
  const before = new Database(join(home, 'nod.db'), { readonly: true })
  const tables = Object.fromEntries(
    before
      .query<{ name: string }, []>(
        "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%'",
      )
      .all()
      .filter((t) => t.name !== 'unmatched_notice_sessions')
      .map((t) => [
        t.name,
        before.query<{ n: number }, []>(`select count(*) n from ${t.name}`).get()?.n ?? -1,
      ]),
  )
  before.close()

  const ledger = new Ledger(home)
  expect(ledger.db.query('pragma user_version').get()).toEqual({ user_version: 33 })
  expect(shape(ledger).tables).toEqual(tables)
  expect(columns(ledger, 'todos')).not.toContain('context')
  expect(columns(ledger, 'todos')).not.toContain('back_to')
  expect(columns(ledger, 'attempts')).not.toContain('cost_usd')
  expect(columns(ledger, 'attempts')).not.toContain('pid')
  expect(ledger.db.query('pragma foreign_key_check').all()).toEqual([])
  expect(new Todos(ledger).get(1)).toMatchObject({ title: 'Mine', status: 'inbox' })
  expect(new Todos(ledger).changes(1)).toEqual([])
  expect(ledger.attempt(1)).toMatchObject({ outcome: 'succeeded', report: 'NOD: done | shipped' })
  expect(ledger.notice(1)).toMatchObject({ note: 'hi', sentAt: 'sent' })
})

test('v33 keeps what a v32 ledger held of a context or a task to go back to in each todo’s history, moves reference todos to someday, and reads failed turns as questions', () => {
  const home = v32Home(`
    insert into todos (id, title, source, status, project_id, context, back_to, followed,
        created_at, status_at)
      values (2, 'Call the bank', 'cli', 'done', null, '@phone', null, null, 'at', 'done-at'),
             (3, 'Watch the deploy', 'cli', 'waiting', 1, null, 2, null, 'at', 'waited'),
             (4, 'Style guide', 'import', 'reference', 1, '@desk', null, 'n1 done', 'at', 'filed'),
             (5, 'Old manual', 'import', 'reference', null, null, null, null, 'at', 'filed');
    update attempts set cost_usd = 0.5, pid = 4242 where id = 1;
    insert into attempts (id, task_id, kind, session_id, prompt, outcome, report, started_at)
      values (2, 2, 'start', 's', 'p', 'failed', 'cannot\nNOD: failed | the repo is gone', 'at'),
             (3, 2, 'answer', 's', 'p', 'failed', 'NOD: failed | still gone', 'at');
    insert into decisions (id, task_id, attempt_id, reason, question, answer, created_at, answered_at)
      values (1, 2, 2, 'failed', 'the repo is gone', 'look again', 'at', 'answered'),
             (2, 2, 3, 'failed', 'still gone', null, 'at', null);
    insert into notices (id, project_id, event, note, created_at, sent_at)
      values (2, 1, 'tell', 'to no row', 'at', 'sent');
    insert into unmatched_notice_sessions (notice_id, session_key) values (2, 'key-gone');`)
  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  expect(ledger.db.query('pragma user_version').get()).toEqual({ user_version: 33 })
  expect(ledger.db.query('pragma foreign_key_check').all()).toEqual([])
  expect(
    ledger.db
      .query("select name from sqlite_schema where name = 'unmatched_notice_sessions'")
      .all(),
  ).toEqual([])

  // Each value is nod's change to none, so `nod todo <todo>` still shows it.
  const change = (id: number) => todos.changes(id).map((c) => [c.actor, c.change])
  expect(change(1)).toEqual([])
  expect(change(2)).toEqual([['nod', { context: ['@phone', null] }]])
  expect(change(3)).toEqual([['nod', { backTo: [2, null] }]])
  expect(todos.changes(3).map(changeText)).toEqual(['backTo n2 → —'])
  expect(change(4)).toEqual([
    ['nod', { context: ['@desk', null] }],
    ['nod', { status: ['reference', 'someday'] }],
  ])
  expect(change(5)).toEqual([['nod', { status: ['reference', 'someday'] }]])
  const at = todos.changes(5)[0]?.at ?? ''
  expect(at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)

  expect(todos.get(2)).toMatchObject({ status: 'done', statusAt: 'done-at' })
  expect(todos.get(3)).toMatchObject({ status: 'waiting', statusAt: 'waited', projectId: 1 })
  expect(todos.get(4)).toMatchObject({
    status: 'someday',
    statusAt: at,
    projectId: 1,
    followed: null,
  })
  expect(todos.get(5)).toMatchObject({ status: 'someday', statusAt: at })
  expect(todos.get(4)).not.toHaveProperty('context')
  expect(todos.get(3)).not.toHaveProperty('backTo')

  expect(ledger.attempt(1)).toMatchObject({ outcome: 'succeeded' })
  expect(ledger.attempt(1)).not.toHaveProperty('costUsd')
  expect(ledger.attempts(2).map((a) => a.outcome)).toEqual(['needs_decision', 'needs_decision'])
  expect(ledger.decisions(2).map((d) => [d.reason, d.answer])).toEqual([
    ['question', 'look again'],
    ['question', null],
  ])
  // Still open, and still trouble enough for a retrospective: the report says the worker gave up.
  expect(ledger.openDecisions().map((d) => d.id)).toEqual([2])
  expect(hadTrouble(ledger, 2)).toBe(true)
  expect(hadTrouble(ledger, 1)).toBe(false)
  expect(ledger.notice(2)).toMatchObject({ sessionId: null, sentAt: 'sent', note: 'to no row' })
})

test('sessions take the roles SESSION_ROLES names and refuse any other', () => {
  const { db } = new Ledger(freshHome())
  const insert = (key: string, role: string): void => {
    db.run(
      "insert into sessions (session_key, role, name, cwd, created_at) values (?, ?, 'n', '/w', 'at')",
      [key, role],
    )
  }
  for (const role of SESSION_ROLES) insert(`key-${role}`, role)
  expect(db.query('select count(*) n from sessions').get()).toEqual({ n: SESSION_ROLES.length })
  expect(() => insert('key-gtd', 'gtd')).toThrow('CHECK constraint failed')
})

test('v24 keeps the project sessions of a v23 ledger, with no socket yet, and has no notices of what ended before it', () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 23)) old.exec(sql)
  old.exec(`pragma user_version = 23;
    insert into projects (id, title, status, created_at, status_at)
      values (1, 'Release', 'active', 'at', 'at');
    insert into project_sessions (session_id, project_id, cwd, created_at)
      values ('cccc3333-0000-4000-8000-00000000000c', 1, '/work/release', 'at');
    insert into tasks (id, brief, status, created_at, finished_at)
      values (1, 'x', 'succeeded', 'at', 'at');`)
  old.close()

  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  expect(todos.latestSession(1)).toMatchObject({ cwd: '/work/release', socket: null })
  expect(ledger.unsentNotices()).toEqual([])
  ledger.error(1, 'boom')
  expect(ledger.unsentNotices()).toMatchObject([{ taskId: 1, event: 'error', note: 'boom' }])
})

test('v25 moves each retrospective that has its outcome to the status the outcome has, closes what it left open, and leaves the rest', () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 24)) old.exec(sql)
  // Retrospective n runs in task n and looks back on task 10 + n. Task 6 is no retrospective; 8
  // waits for retrospective 2, 9 for 8, 10 for task 6, and 21 for retrospective 20, cancelled
  // already.
  old.exec(`pragma user_version = 24;
    insert into tasks (id, brief, status, created_at, finished_at) values
      (11, 'x', 'succeeded', 'at', 'at'), (12, 'x', 'succeeded', 'at', 'at'),
      (13, 'x', 'succeeded', 'at', 'at'), (14, 'x', 'succeeded', 'at', 'at'),
      (15, 'x', 'succeeded', 'at', 'at'), (17, 'x', 'succeeded', 'at', 'at'),
      (30, 'x', 'succeeded', 'at', 'at');
    insert into retros (id, of_task_id, outcome, created_at, ended_at) values
      (1, 11, 'added', 'at', 'ended'), (2, 12, 'declined', 'at', 'ended'),
      (3, 13, 'none', 'at', 'ended'), (4, 14, null, 'at', null), (5, 15, 'dropped', 'at', null),
      (7, 17, 'todo', 'at', 'ended'), (20, 30, 'dropped', 'at', 'ended');
    insert into tasks (id, brief, retro_id, status, created_at, finished_at) values
      (20, 'r20', 20, 'cancelled', 'at', 'ended'), (21, 'after r20', null, 'queued', 'at', null);
    insert into task_deps (task_id, after_id) values (21, 20);
    insert into tasks (id, brief, retro_id, status, error, created_at, finished_at) values
      (1, 'r1', 1, 'needs_decision', null, 'at', null),
      (2, 'r2', 2, 'error', 'boom', 'at', 'failed'),
      (3, 'r3', 3, 'succeeded', null, 'at', 'done'),
      (4, 'r4', 4, 'needs_decision', null, 'at', null),
      (5, 'r5', 5, 'running', null, 'at', null),
      (6, 'plain', null, 'needs_decision', null, 'at', null),
      (7, 'r7', 7, 'error', 'boom', 'at', 'failed'),
      (8, 'after r2', null, 'queued', null, 'at', null),
      (9, 'after 8', null, 'queued', null, 'at', null),
      (10, 'after 6', null, 'queued', null, 'at', null);
    insert into task_deps (task_id, after_id) values (8, 2), (9, 8), (10, 6);
    insert into attempts (id, task_id, kind, session_id, prompt, started_at) values
      (1, 1, 'start', 's1', 'p', 'at'), (4, 4, 'start', 's4', 'p', 'at'),
      (6, 6, 'start', 's6', 'p', 'at');
    insert into decisions (id, task_id, attempt_id, reason, question, created_at) values
      (1, 1, 1, 'rule', 'Add it?', 'at'), (4, 4, 4, 'rule', 'Add it?', 'at'),
      (6, 6, 6, 'question', 'Which?', 'at');`)
  old.close()

  const ledger = new Ledger(home)
  const row = (id: number) => {
    const t = ledger.get(id)
    return [t.status, t.error, t.finishedAt]
  }
  expect([1, 2, 3, 4, 5, 6, 7, 10, 20, 21].map(row)).toEqual([
    ['succeeded', null, 'ended'],
    ['cancelled', null, 'ended'],
    ['succeeded', null, 'done'],
    ['needs_decision', null, null],
    ['cancelled', null, 'at'],
    ['needs_decision', null, null],
    ['succeeded', null, 'ended'],
    ['queued', null, null],
    ['cancelled', null, 'ended'],
    ['queued', null, null],
  ])
  // What waited for the cancelled retrospective is cancelled with it, as it is from then on.
  const when = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  expect([8, 9].map(row)).toEqual([
    ['cancelled', 'task n2 it waits for was cancelled', when],
    ['cancelled', 'task n8 it waits for was cancelled', when],
  ])
  const decided = (id: number) => [ledger.decision(id).answer, ledger.decision(id).answeredAt]
  expect([1, 4, 6].map(decided)).toEqual([
    ['(the retrospective had ended)', null],
    [null, null],
    [null, null],
  ])
  expect(ledger.unsentNotices()).toEqual([])
})

test('v26 keeps the pull request text of a v25 landing, written on no head it knows unless nod pushed it', () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 25)) old.exec(sql)
  old.exec(`pragma user_version = 25;
    insert into tasks (id, brief, created_at) values (1, 'x', 'at'), (2, 'y', 'at'), (3, 'z', 'at');
    insert into landings (task_id, title, body, pushed, pr, updated_at) values
      (1, 'Add a', 'Adds a.', null, null, 'at'),
      (2, 'Add b', 'Adds b.', 'b1', null, 'at'),
      (3, 'Add c', 'Adds c.', 'c1', 'https://example.com/pull/3', 'at');`)
  old.close()
  const ledger = new Ledger(home)
  expect(ledger.landing(1)).toMatchObject({ title: 'Add a', body: 'Adds a.', textHead: null })
  // Pushed, and so through the gate, with its pull request still to open.
  expect(ledger.landing(2)).toMatchObject({ title: 'Add b', textHead: 'b1' })
  expect(ledger.landing(3)).toMatchObject({ title: 'Add c', textHead: null })
})

test("a retrospective's task goes to the status its outcome has as it ends, and nothing later moves it off", () => {
  const ledger = new Ledger(freshHome())
  for (const [outcome, want] of Object.entries(RETRO_STATUS) as [RetroOutcome, TaskStatus][]) {
    const of = ledger.add({
      brief: 'x',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    })
    const retro = ledger.addRetro(ledger.get(of), 'look back')
    const { retroId } = ledger.get(retro)
    if (retroId === null) throw new Error('no retrospective')
    ledger.setRunning(retro, '/work/retro')
    const turn = ledger.startAttempt({
      taskId: retro,
      kind: 'start',
      decisionId: null,
      sessionId: `s-${outcome}`,
      prompt: 'look back',
    })
    ledger.endAttempt(turn, { outcome: 'needs_decision', summary: 'which?', report: null })
    const asked = ledger.ask(retro, turn, 'question', 'Which task?')
    ledger.endRetro(retroId, outcome)
    const ended = ledger.get(retro)
    expect([ended.status, ended.error]).toEqual([want, null])
    // Whatever comes after: an answer, another question dropped, a turn, an error, another end.
    ledger.answer(asked, 'the first')
    ledger.drop(ledger.ask(retro, turn, 'question', 'Still there?'))
    ledger.setRunning(retro, '/work/elsewhere')
    ledger.error(retro, 'late')
    ledger.succeed(retro)
    expect(ledger.get(retro)).toEqual(ended)
    const ends = ledger.db
      .query<{ event: string }, [number]>(
        "select event from notices where task_id = ? and event != 'decision'",
      )
      .all(retro)
    expect(ends.map((n) => n.event)).toEqual([want])
  }
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

test('v28 opens an older ledger with nothing kept, and a kept tell counts between its two tasks until a turn takes it, as a message of that turn', () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 27)) old.exec(sql)
  old.exec(`pragma user_version = 27;
    insert into tasks (id, brief, created_at) values (1, 'x', 'at'), (2, 'y', 'at');`)
  old.close()

  const ledger = new Ledger(home)
  expect(ledger.pendingTells(1)).toEqual([])
  ledger.keepTell(1, 2, 'first')
  ledger.keepTell(1, 2, 'second')
  expect(ledger.tellsBetween(1, 2)).toBe(2)
  expect(ledger.tellsBetween(2, 1)).toBe(2)
  expect(ledger.pendingTells(2)).toEqual([])
  const reopened = new Ledger(home)
  const [first, second] = reopened.pendingTells(1)
  expect([first?.text, second?.text]).toEqual(['first', 'second'])

  const turn = reopened.startAttempt({
    taskId: 1,
    kind: 'start',
    decisionId: null,
    sessionId: 's',
    prompt: 'p',
  })
  if (first === undefined) throw new Error('nothing kept')
  reopened.takeTell(first, turn, 'wrapped')
  expect(reopened.pendingTells(1).map((t) => t.text)).toEqual(['second'])
  expect(reopened.messages(1)).toMatchObject([{ attemptId: turn, text: 'wrapped', fromTask: 2 }])
  expect(reopened.tellsBetween(1, 2)).toBe(2)
})

test('kept tells are lost once, and only those of a task that was cancelled or collected unstarted', () => {
  const ledger = new Ledger(freshHome())
  const add = (brief: string): number =>
    ledger.add({
      brief,
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    })
  const [from, gone, collected, waiting] = [add('from'), add('gone'), add('off'), add('waiting')]
  ledger.keepTell(gone, from, 'lost')
  ledger.keepTell(collected, from, 'collected')
  ledger.keepTell(waiting, from, 'kept')
  ledger.db.query("update tasks set status = 'cancelled' where id = $id").run({ id: gone })
  ledger.collected(collected, null)
  expect(ledger.loseTells().map((t) => [t.taskId, t.text])).toEqual([
    [gone, 'lost'],
    [collected, 'collected'],
  ])
  expect(ledger.loseTells()).toEqual([])
  expect(ledger.pendingTells(gone)).toMatchObject([{ lostAt: expect.any(String) }])
  expect(ledger.pendingTells(waiting)).toMatchObject([{ lostAt: null }])
})

test('a task keeps the session that added it, and its retrospective takes it', () => {
  const ledger = new Ledger(freshHome())
  const task = (rootSession?: string | null) =>
    ledger.add({
      brief: 't',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
      rootSession,
    })
  const id = task('root-a')
  expect(ledger.get(id).rootSession).toBe('root-a')
  expect(ledger.get(ledger.addRetro(ledger.get(id), 'look back')).rootSession).toBe('root-a')
  expect(ledger.get(task(null)).rootSession).toBeNull()
  expect(ledger.get(task()).rootSession).toBeNull()
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

test('a rule turns off or on only when it is not so already, records who did, and is one line', () => {
  const ledger = new Ledger(freshHome())
  const { id } = ledger.addRule('keep it short', null, 'human')
  ledger.setRule(id, 'on', 'human')
  ledger.setRule(id, 'off', 'claude:ab12')
  ledger.setRule(id, 'off', 'human')
  expect(ledger.rule(id)).toMatchObject({ text: 'keep it short', state: 'off', retroId: null })
  const changes = ledger.db
    .query<{ actor: string; change: string }, []>('select actor, change from rule_changes')
    .all()
    .map((c) => [c.actor, JSON.parse(c.change)])
  expect(changes).toEqual([
    ['human', { text: [null, 'keep it short'], state: [null, 'on'] }],
    ['claude:ab12', { state: ['on', 'off'] }],
  ])
  expect(() => ledger.addRule(' ', null, 'human')).toThrow('empty rule')
  expect(() => ledger.addRule('two\nlines', null, 'human')).toThrow('one line')
  expect(() => ledger.setRule(9, 'off', 'human')).toThrow('rule 9 not found')
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
    issue: null,
  })
  ledger.link(id, ['https://example.com/pr/1'])
  ledger.link(id, ['https://example.com/pr/1', 'https://example.com/pr/2'])
  expect(ledger.links(id).sort()).toEqual(['https://example.com/pr/1', 'https://example.com/pr/2'])
  expect(() => ledger.link(id + 1, ['https://example.com/pr/3'])).toThrow('not found')
})

test('a task keeps its issue, and its retrospective carries it', () => {
  const ledger = new Ledger(freshHome())
  const id = ledger.add({
    brief: 't',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: 'PROJ-1',
  })
  expect(ledger.get(id).issue).toBe('PROJ-1')
  expect(ledger.get(ledger.addRetro(ledger.get(id), 'look back')).issue).toBe('PROJ-1')
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
  expect(ledger.get(c).error).toBe(`task n${b} it waits for was cancelled`)
  expect(ledger.get(unrelated).status).toBe('queued')
})

test('in one repo a task can come after only one task, and after only tasks that exist', () => {
  const ledger = new Ledger(freshHome())
  const a = task(ledger, { repo: '/r' })
  const b = task(ledger, { repo: '/r' })
  const elsewhere = task(ledger, { repo: '/s' })
  expect(() => task(ledger, { repo: '/r', after: [a, b] })).toThrow('chain them')
  expect(() => task(ledger, { after: [999] })).toThrow('task n999 not found')
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
