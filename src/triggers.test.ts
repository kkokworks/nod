import { afterAll, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'
import { Todos } from './todos'
import { addTrigger, nextRun, parseItems, scheduleEnv, scheduleOn, shell, tick } from './triggers'

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

test('a daily schedule runs once a day at its hour across a daylight-saving change', () => {
  const tz = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    // Each run from `from` until `until`, as the ticks would run them.
    const runs = (cron: string, from: string, until: string): string[] => {
      const out: string[] = []
      let next = nextRun(cron, new Date(from))
      while (next !== null && next < new Date(until)) {
        out.push(next.toISOString())
        next = nextRun(cron, next)
      }
      return out
    }
    // Daylight saving ends on 2026-11-01: 09:00 is 13:00Z before, 14:00Z after.
    expect(runs('0 9 * * *', '2026-10-31T13:00:00Z', '2026-11-03T00:00:00Z')).toEqual([
      '2026-11-01T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
    ])
    // 01:30 comes twice that day, and runs once.
    expect(runs('30 1 * * *', '2026-10-31T05:30:00Z', '2026-11-03T00:00:00Z')).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ])
    // So does each hour, so an hourly schedule skips the second 01:00.
    expect(runs('0 * * * *', '2026-11-01T04:00:00Z', '2026-11-01T08:00:00Z')).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
    ])
    // It starts on 2026-03-08: 09:00 is 14:00Z before, 13:00Z after.
    expect(runs('0 9 * * *', '2026-03-07T14:00:00Z', '2026-03-10T00:00:00Z')).toEqual([
      '2026-03-08T13:00:00.000Z',
      '2026-03-09T13:00:00.000Z',
    ])
    // 02:30 does not come that day, so it runs once, at 03:30.
    expect(runs('30 2 * * *', '2026-03-07T07:30:00Z', '2026-03-10T00:00:00Z')).toEqual([
      '2026-03-08T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z',
    ])
  } finally {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  }
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

test('schedule on leaves its environment readable by the owner only, and is off again if the OS scheduler refuses it', async () => {
  const home = tmp.make('nod-schedule-')
  const env = join(home, 'schedule.json')
  writeFileSync(env, '{}\n')
  chmodSync(env, 0o644) // as an earlier nod left it, whatever the umask
  // Not the real scheduler, which would register a tick with the OS.
  const cron = spyOn(Bun, 'cron')
  const removed: string[] = []
  Object.assign(Bun.cron, {
    remove: (title: string) => {
      removed.push(title)
      return Promise.resolve()
    },
  })
  try {
    cron.mockImplementation((() => Promise.resolve()) as never)
    await scheduleOn(home)
    expect(statSync(env).mode & 0o777).toBe(0o600)

    // Turned on again, the tick registered before would go on running a tick.ts that is gone.
    cron.mockImplementation((() => Promise.reject(new Error('no scheduler here'))) as never)
    await expect(scheduleOn(home)).rejects.toThrow('no scheduler here')
    expect(scheduleEnv(home)).toBeNull()
    expect(existsSync(join(home, 'tick.ts'))).toBe(false)
    expect(removed).toHaveLength(1)
  } finally {
    cron.mockRestore()
  }
})

test('a timed-out command ends with all of its pipeline, not only the shell', async () => {
  const dir = tmp.make('nod-shell-')
  const mark = join(dir, 'left')
  const started = Date.now()
  // A limit long enough for the pipeline to be running when it passes.
  const pipeline = `(sleep 2; touch ${JSON.stringify(mark)}) | cat`
  const { code } = await shell(pipeline, dir, process.env, 1000)
  expect(code).not.toBe(0)
  expect(Date.now() - started).toBeLessThan(2000)
  // Killing only `sh` would leave the rest of the pipeline to run on, past the output it holds.
  await Bun.sleep(3000 - (Date.now() - started))
  expect(existsSync(mark)).toBe(false)
})

test('a command does not wait on what left its group holding its output, and keeps what it printed', async () => {
  const dir = tmp.make('nod-shell-')
  const left = `perl -e 'use POSIX; setsid(); sleep 4'`
  // Timed out: a limit long enough for perl to have left the group when it passes.
  let started = Date.now()
  const timedOut = await shell(`echo item; ${left}; sleep 5`, dir, process.env, 1000)
  expect(timedOut).toMatchObject({ stdout: 'item\n' })
  expect(timedOut.code).not.toBe(0)
  expect(Date.now() - started).toBeLessThan(3000)
  // Ended, with it left in the background.
  started = Date.now()
  expect(await shell(`echo item; ${left} &`, dir, process.env, 1000)).toEqual({
    code: 0,
    stdout: 'item\n',
    stderr: '',
  })
  expect(Date.now() - started).toBeLessThan(2000)
})
