import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { projectFolder } from '../test/projects'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'
import { actorFromEnv, openSession, sessionFromEnv } from './todo-cli'
import { Todos } from './todos'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const cli = resolve(import.meta.dir, 'cli.ts')

// Runs nod as a person at a terminal would, so changes record `human`. Times become `<time>`.
// It gets the test's time zone: bun test runs in UTC without setting TZ, so nod would otherwise
// see another day than the test does between local midnight and the UTC one.
function nod(home: string) {
  const { CLAUDECODE: _, NOD_TASK: __, NOD_ACTOR: ___, ...env } = process.env
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
  return async (...args: string[]): Promise<{ code: number; out: string[]; err: string }> => {
    const p = Bun.spawn(['bun', cli, ...args], {
      env: { ...env, NOD_HOME: home, TZ },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    const lines = out
      .trimEnd()
      .split('\n')
      .map((l) => l.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, '<time>'))
    return { code, out: lines, err }
  }
}

const runner = () => {
  const home = tmp.make('nod-todo-cli-')
  const run = nod(home)
  const ok = async (...args: string[]) => {
    const r = await run(...args)
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    return r.out
  }
  const fails = async (...args: string[]) => {
    const r = await run(...args)
    expect(r.code).not.toBe(0)
    return r.err
  }
  return { ok, fails, home }
}

test('capture, clarify into a project, finish, and read back who changed what', async () => {
  const { ok } = runner()
  expect(await ok('in', 'Call', 'the', 'dentist')).toEqual([
    't1    inbox     Call the dentist  · since <time>',
  ])
  expect(await ok('project', 'add', 'Health', '--outcome', 'Teeth fixed')).toEqual([
    'p1    active   Health — Teeth fixed',
  ])
  expect(await ok('project')).toEqual([
    'p1    active   Health — Teeth fixed  0 next  0 waiting  · no next action',
  ])
  expect(
    await ok('todo', 'set', 't1', '--status', 'next', '--project', 'Health', '--context', 'phone'),
  ).toEqual(['t1    next      Call the dentist  · @phone · p1 Health'])
  expect(await ok('in', 'Ask about the invoice')).toEqual([
    't2    inbox     Ask about the invoice  · since <time>',
  ])
  await ok('todo', 'set', 't2', '--status', 'waiting', '--waiting-on', 'Kim', '--project', 'p1')
  expect(await ok('todo')).toEqual([
    't1    next      Call the dentist  · @phone · p1 Health',
    't2    waiting   Ask about the invoice  · p1 Health · waiting on Kim · since <time>',
  ])
  expect(await ok('todo', 'next', '--context', '@phone')).toEqual([
    't1    next      Call the dentist  · @phone · p1 Health',
  ])
  expect(await ok('project')).toEqual(['p1    active   Health — Teeth fixed  1 next  1 waiting'])
  expect(await ok('project', 'p1')).toEqual([
    'p1    active   Health — Teeth fixed',
    '  t1    next      Call the dentist  · @phone · p1 Health',
    '  t2    waiting   Ask about the invoice  · p1 Health · waiting on Kim · since <time>',
    '  changes',
    '    <time>  human  title — → Health, outcome — → Teeth fixed, status — → active',
  ])

  expect(await ok('todo', 'done', 't1', 't2')).toEqual([
    't1    done      Call the dentist  · @phone · p1 Health · on <time>',
    't2    done      Ask about the invoice  · p1 Health · on <time>',
  ])
  expect(await ok('todo')).toEqual([''])
  expect(await ok('project', 'done', 'p1')).toEqual(['p1    done     Health — Teeth fixed'])

  expect(await ok('todo', 't2')).toEqual([
    't2 done: Ask about the invoice',
    '  p1 Health · on <time>',
    '  from cli',
    '  changes',
    '    <time>  human  title — → Ask about the invoice, status — → inbox, source — → cli',
    '    <time>  human  status inbox → waiting, waiting on — → Kim, project — → p1',
    '    <time>  human  status waiting → done, waiting on Kim → —',
  ])
})

test('a channel key is captured once, and bad input is refused without changing anything', async () => {
  const { ok, fails, home } = runner()
  expect(await ok('in', 'Review the PR', '--source', 'chat', '--key', 'm1')).toEqual([
    't1    inbox     Review the PR  · since <time>',
  ])
  expect(await ok('in', 'Review the PR again', '--source', 'chat', '--key', 'm1')).toEqual([
    't1    inbox     Review the PR  · since <time>  (already captured)',
  ])

  expect(await fails('in', 'x', '--key', 'm2')).toContain('--key needs --source')
  expect(await fails('in', 'x', '--link', '')).toContain('empty link')
  expect(await fails('todo', 'set', 't1', '--status', 'later')).toContain(
    'a todo status is one of inbox, next, waiting',
  )
  // A bare number could be a decision (`nod 1 …`) or a task (`nod drop 1`).
  expect(await fails('todo', '1')).toContain('not a todo: 1 (write t<n>)')
  expect(await fails('todo', 'done')).toContain('finished todos list with --all')
  expect(await fails('todo', 'next', '--all')).toContain('--all lists every status')
  expect(await fails('project', '1')).toContain('not a project: 1 (write p<n>)')
  // A watch runs once when given; one that would never wait, or never run, is refused.
  const watch = (cmd: string) => fails('todo', 'set', 't1', '--status', 'waiting', '--watch', cmd)
  expect(await watch('true')).toContain('the watch passes already')
  expect(await watch('no-such-command-here')).toContain('the watch cannot run')
  expect(await watch('test -f "x')).toContain('the watch does not parse')
  // An edit that would be refused is refused before its watch runs.
  const ran = join(home, 'ran')
  expect(await fails('todo', 'set', 't1', '--watch', `touch ${JSON.stringify(ran)}`)).toContain(
    'a watch is for a waiting todo',
  )
  expect(existsSync(ran)).toBe(false)
  expect(await ok('todo', '--all')).toEqual(['t1    inbox     Review the PR  · since <time>'])
})

test('a watch shows when it last ran and how, and says when nothing will run it', async () => {
  const { ok } = runner()
  await ok('in', 'Hear back on the quote')
  expect(
    await ok('todo', 'set', 't1', '--status', 'waiting', '--watch', 'echo not yet; exit 1'),
  ).toEqual([
    't1    waiting   Hear back on the quote  · watched, checked <time> · since <time>',
    '  checked <time>, exit 1: not yet',
    '  the schedule is off, so nothing runs it yet: turn it on with `nod schedule on`',
  ])
  expect(await ok('todo', 't1')).toEqual([
    't1 waiting: Hear back on the quote',
    '  watched, checked <time> · since <time>',
    '  from cli',
    '  watch echo not yet; exit 1',
    '    checked <time>, exit 1: not yet',
    '  changes',
    '    <time>  human  title — → Hear back on the quote, status — → inbox, source — → cli',
    '    <time>  human  status inbox → waiting, watch — → echo not yet; exit 1',
  ])
})

test('the todos of a someday project leave the lists until it is named', async () => {
  const { ok } = runner()
  await ok('project', 'add', 'Trip')
  await ok('in', 'Pick dates')
  await ok('todo', 'set', 't1', '--status', 'next', '--project', 'Trip')
  await ok('project', 'set', 'p1', '--status', 'someday')
  expect(await ok('todo')).toEqual([''])
  expect(await ok('todo', '--project', 'p1')).toEqual(['t1    next      Pick dates  · p1 Trip'])
  expect(await ok('todo', '--all')).toEqual(['t1    next      Pick dates  · p1 Trip'])
})

test('captures run at the same time each land once, on a ledger none had opened', async () => {
  const { ok } = runner()
  const n = 20
  await Promise.all(Array.from({ length: n }, (_, i) => ok('in', `item ${i}`)))
  expect(await ok('todo')).toHaveLength(n)
})

test('nod in --project captures the todo into that project, and a project that is not there captures nothing', async () => {
  const { ok, fails } = runner()
  await ok('project', 'add', 'Release')
  expect(await ok('in', 'Tag', 'it', '--project', 'Release')).toEqual([
    't1    inbox     Tag it  · p1 Release · since <time>',
  ])
  expect(await ok('in', 'Write the notes', '--project', 'p1')).toEqual([
    't2    inbox     Write the notes  · p1 Release · since <time>',
  ])
  expect(await fails('in', 'Draw it', '--project', 'p9')).toContain('no project p9')
  expect(await ok('todo', 'inbox')).toHaveLength(2)
})

test('nod open resumes the latest session where it was opened, or starts one: with --new, with none yet, and again under its ID while Claude Code keeps no transcript of it, named after the project every way', () => {
  const todos = new Todos(new Ledger(tmp.make('nod-open-')))
  const config = tmp.make('nod-open-config-')
  const [here, there] = [tmp.make('nod-open-here-'), tmp.make('nod-open-there-')]
  const p = todos.addProject({ title: 'Release', outcome: null }, 'human')
  const open = (fresh: boolean, cwd: string, ref = `p${p.id}`) =>
    openSession(todos, ref, fresh, cwd, config)
  const key = (): string => todos.latestSession(p.id)?.sessionId ?? ''
  // Claude in the session hears its project, opened anew or resumed.
  const told = [
    '--append-system-prompt',
    `nod open opened this session for project p${p.id} Release: nod add here puts work in that project, and the project's tasks and decisions are this session's.`,
  ]

  const first = open(false, here)
  const opened = key()
  expect(opened).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(first).toEqual({
    argv: ['claude', '--name', 'Release', '--session-id', opened, ...told],
    cwd: here,
  })
  // Closed before a word was said, it has no transcript, so it starts again where it was opened.
  expect(open(false, there)).toEqual(first)
  expect(key()).toBe(opened)
  // Claude Code keeps a session's transcript where it ran, with a line for each thing said.
  const keep = (session: string, cwd: string, line: string): void => {
    const folder = projectFolder(config, cwd)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${session}.jsonl`), `${line}\n`)
  }
  const said = '{"type":"user","message":{"role":"user","content":"hi"}}'
  // Once something is said in it, it is resumed there, wherever nod open runs.
  keep(opened, here, said)
  // Resumed, it is named again, so a /rename goes back to the project's title.
  const resumed = { argv: ['claude', '--resume', opened, '--name', 'Release', ...told], cwd: here }
  expect(open(false, there)).toEqual(resumed)
  expect(open(false, there, 'Release')).toEqual(resumed)
  // --new opens another here, which is the project's from now on: nod open opens it after.
  const second = open(true, there)
  const newer = key()
  expect(newer).not.toBe(opened)
  expect(second).toEqual({
    argv: ['claude', '--name', 'Release', '--session-id', newer, ...told],
    cwd: there,
  })
  expect(todos.sessionPlace(opened)?.latest).toBe(false)
  expect(open(false, here)).toEqual(second)
  keep(newer, there, said)
  expect(open(false, here)).toEqual({
    argv: ['claude', '--resume', newer, '--name', 'Release', ...told],
    cwd: there,
  })
  expect(key()).toBe(newer)
  // The folder it was opened in is gone: no session to resume there.
  rmSync(there, { recursive: true })
  expect(() => open(false, here)).toThrow(
    `p${p.id}'s session was opened in ${there}, which is gone; nod open p${p.id} --new opens a new one here`,
  )
  // A transcript with nothing said in it, a title alone, opens neither way: a new session instead.
  open(true, here)
  const titled = key()
  keep(titled, here, `{"type":"custom-title","customTitle":"Release","sessionId":"${titled}"}`)
  const fourth = open(false, here)
  expect(key()).not.toBe(titled)
  expect(fourth).toEqual({
    argv: ['claude', '--name', 'Release', '--session-id', key(), ...told],
    cwd: here,
  })
  // So does an empty one, and one whose folder is gone: the new session opens here, not there.
  const emptied = key()
  writeFileSync(join(projectFolder(config, here), `${emptied}.jsonl`), '')
  open(false, here)
  expect(key()).not.toBe(emptied)
  const gone = tmp.make('nod-open-gone-')
  open(true, gone)
  keep(key(), gone, `{"type":"custom-title","customTitle":"Release","sessionId":"${key()}"}`)
  rmSync(gone, { recursive: true })
  const before = key()
  expect(open(false, here)).toEqual({
    argv: ['claude', '--name', 'Release', '--session-id', key(), ...told],
    cwd: here,
  })
  expect(key()).not.toBe(before)
  // A long title is cut, with the project's number in front.
  const long = todos.addProject(
    { title: 'Migrate every billing service to the new ledger format', outcome: null },
    'human',
  )
  expect(open(false, here, `p${long.id}`).argv[2]).toBe(
    `p${long.id} Migrate every billing service to the`,
  )
  expect(() => open(false, here, 'p9')).toThrow('no project p9')
})

test('the actor is NOD_ACTOR if set, else a worker, a Claude session, or a person', () => {
  expect(actorFromEnv({ NOD_ACTOR: 'human:ui', NOD_TASK: '7' })).toBe('human:ui')
  expect(actorFromEnv({ NOD_TASK: '7', CLAUDECODE: '1' })).toBe('worker:7')
  expect(actorFromEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abcdef12-3456' })).toBe(
    'claude:abcdef12',
  )
  expect(actorFromEnv({ CLAUDECODE: '1' })).toBe('claude')
  expect(actorFromEnv({})).toBe('human')
})

test('the session is the whole id of the Claude session acting, and none where the actor is not one', () => {
  const id = 'abcdef12-3456'
  expect(sessionFromEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: id })).toBe(id)
  expect(sessionFromEnv({ CLAUDECODE: '1' })).toBeNull()
  expect(sessionFromEnv({ CLAUDE_CODE_SESSION_ID: id })).toBeNull()
  expect(sessionFromEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: id, NOD_TASK: '7' })).toBeNull()
  expect(
    sessionFromEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: id, NOD_ACTOR: 'human:ui' }),
  ).toBeNull()
})

test('a todo delegated with nod add waits on its task, whose decision is listed first', async () => {
  const { ok, home } = runner()
  await ok('in', 'Write the release notes', '--notes', 'For v2')
  await ok('project', 'add', 'Release')
  await ok('todo', 'set', 't1', '--project', 'p1')
  // The delegated task comes after one that never starts here, so no worker runs.
  const ledger = new Ledger(home)
  const first = ledger.add({
    brief: 'first',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  expect(await ok('add', '--todo', 't1', '--after', String(first))).toEqual(['2'])
  expect(await ok('todo', 'waiting')).toEqual([
    't1    waiting   Write the release notes  · p1 Release · waiting on task #2 (queued) · since <time>',
  ])
  const shown = await ok('show', '2')
  expect(shown).toContain('  brief: Write the release notes')
  expect(shown).toContain('  todo: t1')

  const attempt = ledger.startAttempt({
    taskId: 2,
    kind: 'start',
    decisionId: null,
    sessionId: 's',
    prompt: 'p',
  })
  ledger.ask(2, attempt, 'question', 'Which version?')
  expect(await ok('todo')).toEqual([
    '#1    decide    Write the release notes  · question · task #2 · p1 Release · since <time>',
    't1    waiting   Write the release notes  · p1 Release · waiting on task #2 (needs_decision) · since <time>',
  ])
  expect(await ok('todo', 'next', '--context', 'phone')).toHaveLength(1)
  expect(await ok('todo', 'inbox')).toEqual([''])
  expect(await ok('project')).toEqual(['p1    active   Release  1 next  1 waiting'])
  expect((await ok('todo', 't1')).filter((l) => l.startsWith('  task'))).toEqual([
    '  task #2 needs_decision',
  ])
})

test('nod search shows the one match as its own command does, and lists several with theirs', async () => {
  const { ok, fails, home } = runner()
  await ok('in', 'Write the report')
  await ok('project', 'add', 'Health')
  // Task #1 does t1; it is only queued, so no worker runs.
  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  const taskId = todos.delegate(
    1,
    {
      brief: 'Draft the report\nwith the numbers',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    },
    'human',
  )
  const ask = (question: string) =>
    ledger.ask(
      taskId,
      ledger.startAttempt({ taskId, kind: 'start', decisionId: null, sessionId: 's', prompt: 'p' }),
      'question',
      question,
    )
  ask('Which chart?')

  expect(await ok('search', '1')).toEqual([
    't1    todo     waiting        Write the report  · nod todo t1',
    '#1    task     needs_decision Draft the report  · nod show 1',
    'p1    project  active         Health  · nod project p1',
    '1     decision open           Which chart?  · nod show 1',
  ])
  expect(await ok('search', 't1')).toEqual(await ok('todo', 't1'))
  expect(await ok('search', '#1')).toEqual(await ok('show', '1'))
  expect(await ok('search', 'p1')).toEqual(await ok('project', 'p1'))

  // Decision 2 alone has the number 2: shown as `nod` lists it, or with its answer once it has one.
  ledger.answer(1, 'a bar')
  ask('And the colour?')
  expect(await ok('search', '2')).toEqual(await ok())
  ledger.answer(2, 'blue')
  expect(await ok('search', '2')).toEqual([
    '#2  question  (task #1 t1: Draft the report with the numbers)',
    '  And the colour?',
    '',
    'answered: blue',
  ])

  ledger.addRetro(ledger.get(taskId), 'look back')
  expect(await ok('search', 'r1')).toEqual(await ok('show', 'r1'))
  expect(await ok('search', '1')).toContain(
    'r1    retro    queued         of #1: Draft the report  · nod show r1',
  )

  for (const none of ['9', 't2', 'x1']) {
    expect(await fails('search', none)).toBe(`no match for ${none}\n`)
  }
})

test('nod today shows the day without a calendar here, and later todos stay out of the lists', async () => {
  const { ok, fails } = runner()
  await ok('in', 'Pay the invoice')
  await ok('todo', 'set', 't1', '--status', 'next', '--due', '2020-01-01')
  await ok('in', 'Call the bank')
  await ok('todo', 'set', 't2', '--status', 'next', '--on', 'today 15:00')
  await ok('in', 'Write the notes')
  await ok('todo', 'set', 't3', '--focus', 'today')
  await ok('in', 'File the return')
  await ok('todo', 'set', 't4', '--status', 'next', '--start', '2099-01-01', '--repeat', 'monthly')
  const today = new Date().toLocaleDateString('sv-SE')
  const [date, events, ...rest] = await ok('today')
  expect(date).toStartWith(today)
  expect(events).toStartWith('events: no calendar; on macOS, build one with sh ')
  expect(rest).toEqual([
    'overdue',
    '  t1    next      Pay the invoice  · due 2020-01-01',
    'scheduled',
    '  t2    next      Call the bank  · scheduled <time>',
    'focus',
    `  t3    inbox     Write the notes  · focus ${today} · since <time>`,
  ])
  expect(await ok('todo', 'next')).toEqual([
    't1    next      Pay the invoice  · due 2020-01-01',
    't2    next      Call the bank  · scheduled <time>',
  ])
  expect((await ok('todo', '--all')).at(-1)).toBe(
    't4    next      File the return  · starts 2099-01-01 · repeats monthly',
  )
  expect(await fails('todo', 'set', 't1', '--start', 'today 10:00')).toContain('a day only')
  expect(await fails('todo', 'set', 't1', '--repeat', 'yearly')).toContain(
    '--repeat is one of daily, weekly, monthly',
  )
  expect(await fails('today', 'someday')).toContain('not a day: someday')
})

test('nod todo --json, check and its once-a-day nudge, and today over several days', async () => {
  const { ok, home } = runner()
  await ok('in', 'Pay the invoice', '--link', 'https://example.com/i/1')
  await ok('todo', 'set', 't1', '--status', 'next', '--due', '2020-01-01')
  await ok('in', 'Call the bank')
  await ok('todo', 'set', 't2', '--status', 'next', '--on', 'tomorrow 15:00')
  const [first, ...rest] = (await ok('todo', '--json')).map((l) => JSON.parse(l))
  expect(rest).toHaveLength(1)
  expect(first).toMatchObject({ id: 1, due: '2020-01-01', links: ['https://example.com/i/1'] })

  await ok('todo', 'set', 't2', '--add-note', 'From the bank letter')
  await ok('todo', 'set', 't2', '--add-note', 'Ask about the fee')
  expect((await ok('todo', 't2')).slice(-7, -5)).toEqual([
    '    From the bank letter',
    '    Ask about the fee',
  ])
  const check = await ok('todo', 'check')
  expect(check.slice(0, 2)).toEqual(['inbox    0', 'overdue  1: t1 Pay the invoice'])
  expect(check.at(-1)).toBe('review   weekly: none done yet')
  const nudge = JSON.parse((await ok('todo', 'check', '--nudge')).join(''))
  expect(nudge.systemMessage).toBe('nod · overdue 1 → /gtd:today')
  expect(await ok('todo', 'check', '--nudge')).toEqual([''])
  // Not in a nod worker, which no person reads.
  await Bun.write(`${home}/.nudged`, '')
  const worker = Bun.spawn(
    ['bun', resolve(import.meta.dir, 'cli.ts'), 'todo', 'check', '--nudge'],
    {
      env: { ...process.env, NOD_HOME: home, NOD_TASK: '1' },
      stdout: 'pipe',
    },
  )
  expect(await new Response(worker.stdout).text()).toBe('')

  const tomorrow = await ok('today', '--days', '3')
  expect(tomorrow[1]).toStartWith('events: no calendar')
  expect(tomorrow.filter((l) => !l.startsWith('events'))).toEqual([
    expect.stringMatching(/^\d{4}-\d{2}-\d{2} \w{3}$/),
    'overdue',
    '  t1    next      Pay the invoice  · due 2020-01-01',
    expect.stringMatching(/^\d{4}-\d{2}-\d{2} \w{3}$/),
    'scheduled',
    '  t2    next      Call the bank  · scheduled <time>',
  ])
})
