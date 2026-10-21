import { afterAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'
import { actorFromEnv } from './todo-cli'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const cli = resolve(import.meta.dir, 'cli.ts')

// Runs nod as a person at a terminal would, so changes record `human`. Times become `<time>`.
function nod(home: string) {
  const { CLAUDECODE: _, NOD_TASK: __, NOD_ACTOR: ___, ...env } = process.env
  return async (...args: string[]): Promise<{ code: number; out: string[]; err: string }> => {
    const p = Bun.spawn(['bun', cli, ...args], {
      env: { ...env, NOD_HOME: home },
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
  const { ok, fails } = runner()
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
  expect(await ok('todo', '--all')).toEqual(['t1    inbox     Review the PR  · since <time>'])
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

test('the actor is NOD_ACTOR if set, else a worker, a Claude session, or a person', () => {
  expect(actorFromEnv({ NOD_ACTOR: 'human:ui', NOD_TASK: '7' })).toBe('human:ui')
  expect(actorFromEnv({ NOD_TASK: '7', CLAUDECODE: '1' })).toBe('worker:7')
  expect(actorFromEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abcdef12-3456' })).toBe(
    'claude:abcdef12',
  )
  expect(actorFromEnv({ CLAUDECODE: '1' })).toBe('claude')
  expect(actorFromEnv({})).toBe('human')
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
  expect(nudge.systemMessage).toBe('nod · overdue 1 → /nod')
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
