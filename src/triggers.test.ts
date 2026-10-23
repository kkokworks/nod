import { afterAll, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'
import { Todos } from './todos'
import { addTrigger, nextRun, parseItems, shell, tick } from './triggers'

// Only what runs without workers; the tick's triggers start tasks, so they are tested with the
// fake agent in worker.test.ts. Its watches start none and are tested here.
const tmp = tempDirs()
afterAll(tmp.removeAll)

test('a source line is one item, keyed by what comes before a tab, which is also its issue', () => {
  expect(parseItems('12\tFix login\n\nplain line\n')).toEqual([
    { key: '12', issue: '12', text: 'Fix login' },
    { key: 'plain line', issue: null, text: 'plain line' },
  ])
})

test('schedules are read in local time', () => {
  const at = (day: number, hour: number): Date => new Date(2026, 9, day, hour, 0)
  expect(nextRun('0 9 * * *', at(6, 8))).toEqual(at(6, 9))
  expect(nextRun('0 9 * * *', at(6, 10))).toEqual(at(7, 9))
  expect(nextRun('0 9 * * MON-FRI', at(9, 10))).toEqual(at(12, 9)) // Friday to Monday
  expect(() => nextRun('every day', at(6, 8))).toThrow('Invalid cron expression')
})

test('adding a trigger with a source records what it lists now, and a failing source adds none', async () => {
  const home = tmp.make('nod-triggers-')
  const ledger = new Ledger(home)
  const items = join(home, 'items.txt')
  writeFileSync(items, 'a\tfirst\nb\tsecond\n')
  const base = {
    cron: '*/5 * * * *',
    brief: 'look',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
  }
  const added = await addTrigger(ledger, home, { ...base, source: `cat ${JSON.stringify(items)}` })
  expect(added.seen).toBe(2)
  expect(ledger.addItemTask(ledger.trigger(added.id), 'a', 'a', 'look')).toBeNull()

  await expect(addTrigger(ledger, home, { ...base, source: 'exit 3' })).rejects.toThrow('exited 3')
  expect(ledger.triggers().map((t) => t.id)).toEqual([added.id])
})

test('a tick with watches brings back the todo whose watch exits 0, or can no longer run', async () => {
  const home = tmp.make('nod-watches-')
  const todos = new Todos(new Ledger(home))
  const flag = join(home, 'pushed')
  const waiting = (title: string, watch: string) => {
    const { todo } = todos.capture(
      { title, notes: null, source: 'cli', sourceKey: null, url: null },
      'human',
    )
    return todos.set(todo.id, { status: 'waiting', watch }, 'human').id
  }
  const pushed = waiting('Get the repo pushed', `test -f ${JSON.stringify(flag)}`)
  const never = waiting('Hear back', 'exit 2') // a failing command is not yet, not an error
  const gone = waiting('See it merged', 'no-such-command-here') // the tick's PATH lacks it

  writeFileSync(flag, '')
  const now = new Date()
  expect((await tick(todos.ledger, home, now, false)).passed).toEqual([])
  expect(todos.get(pushed).status).toBe('waiting')
  expect((await tick(todos.ledger, home, now, true)).passed).toEqual([pushed])
  expect([pushed, never, gone].map((id) => todos.get(id).status)).toEqual([
    'next',
    'waiting',
    'next',
  ])
  expect(todos.get(gone).notes).toMatch(/ watch cannot run \(.*not found\): no-such-command-here$/)
  // Each run is kept, for the watch it ran.
  expect(todos.lastCheck(todos.get(never))).toMatchObject({ watch: 'exit 2', code: 2, output: '' })
  expect(todos.watched().map((t) => t.id)).toEqual([never])
})

test('a timed-out command ends with all of its pipeline, not only the shell', async () => {
  const started = Date.now()
  const { code } = await shell('sleep 5 | cat', tmp.make('nod-shell-'), process.env, 200)
  expect(code).not.toBe(0)
  expect(Date.now() - started).toBeLessThan(2000)
})

test('a timed-out command does not wait on what left its group holding its output', async () => {
  const started = Date.now()
  const left = `perl -e 'use POSIX; setsid(); sleep 4'; sleep 5`
  const { code } = await shell(left, tmp.make('nod-shell-'), process.env, 300)
  expect(code).not.toBe(0)
  expect(Date.now() - started).toBeLessThan(2000)
})
