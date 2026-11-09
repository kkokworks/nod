import { afterAll, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'
import { Tmux } from './tmux'
import { Todos } from './todos'
import { scheduleEnv, scheduleOn, shell, tick } from './triggers'

// Only what runs without workers: the watches start none.
const tmp = tempDirs()
afterAll(tmp.removeAll)

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
  expect((await tick(todos.ledger, home, Tmux.of(home), now, false)).passed).toEqual([])
  expect(todos.get(pushed).status).toBe('waiting')
  expect((await tick(todos.ledger, home, Tmux.of(home), now, true)).passed).toEqual([pushed])
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
  expect(timedOut).toMatchObject({ stdout: 'item\n', timedOut: true })
  expect(timedOut.code).not.toBe(0)
  expect(Date.now() - started).toBeLessThan(3000)
  // Ended, with it left in the background.
  started = Date.now()
  expect(await shell(`echo item; ${left} &`, dir, process.env, 1000)).toEqual({
    code: 0,
    stdout: 'item\n',
    stderr: '',
    timedOut: false,
  })
  expect(Date.now() - started).toBeLessThan(2000)
})
