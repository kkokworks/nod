import { afterAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
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
  const run = nod(tmp.make('nod-todo-cli-'))
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
  return { ok, fails }
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
