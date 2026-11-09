import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { followWork, sweep } from './done'
import { savedEnv } from './env'
import { sendNotices } from './inbox'
import { land, type Moved } from './land'
import { Ledger } from './ledger'
import { notify } from './notify'
import { message, runGroup } from './proc'
import { pullRequests } from './prs'
import { homeId, type Terminals, Tmux } from './tmux'
import { Todos } from './todos'
import { oneLine } from './view'
import {
  closeFinished,
  cutChecks,
  lostTurns,
  overdueWaits,
  reportLostTells,
  restartDue,
  SELF,
} from './worker'

// The tick: what nod does on its own between commands (tick), and the watches that tell when what a
// waiting todo waits on has happened. Once `nod schedule on` registers it, the OS scheduler (launchd
// on macOS, crontab on Linux, through Bun.cron) runs tick every minute; nod itself still never stays
// running. ponytail: the file keeps the name it had while it ran triggers too (until v32), as the
// tick module `nod schedule on` wrote imports it by path (tickModule).

// A hung watch must not stall every later tick.
const WATCH_TIMEOUT_MS = 60_000
const OUTPUT_LIMIT = 2000
// Watches mostly ask another service; every minute would be more calls than a wait needs.
const WATCH_EVERY_MINUTES = 5

// Asks about the turns whose terminal is gone and the tasks that waited too long on background
// work, goes on from the checks Stop hooks did not finish, restarts the workers due a restart, and
// closes the terminals of tasks finished a while ago (worker.ts), then, with `watches`, the watches
// and gc of the finished tasks a signal says are done with (done.ts).
export async function tick(
  ledger: Ledger,
  home: string,
  terminals: Terminals,
  now: Date,
  watches: boolean,
): Promise<{
  passed: number[]
  collected: number[]
  lost: number[]
  waited: number[]
  cut: number[]
  restarted: number[]
  closed: number[]
  landed: Moved[]
}> {
  const lost = await lostTurns(ledger, home, terminals, now)
  const waited = await overdueWaits(ledger, home, now)
  const cut = await cutChecks(ledger, home, terminals)
  // An account rule that cannot be read must not stop the watches.
  const restarted = await restartDue(ledger, home, terminals).catch((error) => {
    console.error(`nod: could not restart workers: ${message(error)}`)
    return []
  })
  const closed = await closeFinished(ledger, home, terminals, now)
  const passed = watches ? await checkWatches(ledger, home) : []
  // Before the sweep, so a task whose pull request it just merged is collected on the same pass.
  // One repo that cannot land must not stop the sweep.
  const landed = watches
    ? await land(ledger, home, terminals).catch((error) => {
        console.error(`nod: could not land: ${message(error)}`)
        return []
      })
    : []
  // One lookup for both, so a pull request is read once. The todos first: the sweep may delete a
  // branch they are read by.
  const prs = pullRequests(home)
  if (watches) {
    await followWork(ledger, SELF, prs).catch((error) =>
      console.error(`nod: could not follow the todos' tasks: ${message(error)}`),
    )
  }
  // Clean: one whose workspace was gone already, collected all the same.
  const collected = watches
    ? await sweep(ledger, home, terminals, prs, now).then(({ report }) => [
        ...report.removed,
        ...report.clean,
      ])
    : []
  await reportLostTells(ledger, home).catch((error) =>
    console.error(`nod: could not report the messages nod kept: ${message(error)}`),
  )
  // What no notify sent yet: a session that was not running, a send that failed, an end no event
  // follows (a landing turn's).
  await sendNotices(ledger).catch((error) =>
    console.error(`nod: could not tell the sessions: ${message(error)}`),
  )
  return { passed, collected, lost, waited, cut, restarted, closed, landed }
}

// A watch passes when it exits 0. A command the shell cannot run (126, 127) never will; anything
// else, a failed request too, means not yet. It runs in <home>, so it names the repo it asks about.
async function runWatch(
  watch: string,
  home: string,
  env: Record<string, string | undefined>,
): Promise<{ code: number; output: string }> {
  const { code, stdout, stderr } = await shell(watch, home, env)
  return { code, output: (stdout + stderr).trim().slice(-OUTPUT_LIMIT) }
}

const cannotRun = (code: number): boolean => code === 126 || code === 127

// Runs a new watch once, with the PATH the tick will give it. One that does not parse, cannot run,
// or passes already is refused: it would never wait, or never end. Any other failure looks like
// not yet, so how it ended is recorded and shown.
// ponytail: only the schedule's PATH and Claude config dir are the tick's; the rest of this shell's
// environment (a token in it) is not, so a watch that needs it passes here and fails in the tick.
export async function tryWatch(
  watch: string,
  home: string,
): Promise<{ code: number; output: string }> {
  const parsed = Bun.spawnSync(['sh', '-n', '-c', watch], { stdout: 'ignore', stderr: 'pipe' })
  if (parsed.exitCode !== 0) {
    throw new Error(`the watch does not parse: ${parsed.stderr.toString().trim()}`)
  }
  const tried = await runWatch(watch, home, { ...process.env, ...scheduleEnv(home) })
  if (tried.code === 0) throw new Error('the watch passes already, so there is nothing to wait for')
  if (cannotRun(tried.code)) throw new Error(`the watch cannot run: ${tried.output}`)
  return tried
}

// One at a time, so two watches on the same service do not call it at once. Each run is recorded,
// so the person sees a watch is alive and why it has not passed. One that can no longer run (the
// schedule was turned on again from a shell whose PATH lacks its command) ends, so its todo does
// not wait on nothing.
async function checkWatches(ledger: Ledger, home: string): Promise<number[]> {
  const todos = new Todos(ledger)
  const passed: number[] = []
  for (const t of todos.watched()) {
    const { code, output } = await runWatch(t.watch, home, process.env)
    todos.recordCheck(t.id, t.watch, code, output)
    if (code !== 0 && !cannotRun(code)) continue
    const outcome = code === 0 ? 'passed' : `cannot run (${oneLine(output, 200)})`
    if (!todos.endWatch(t.id, t.watch, outcome, SELF)) continue
    const todo = { id: t.id, title: t.title }
    if (code === 0) {
      passed.push(t.id)
      await notify(home, { event: 'watch_passed', todo, watch: t.watch })
    } else {
      await notify(home, { event: 'watch_failed', todo, watch: t.watch, error: output })
    }
  }
  return passed
}

// Runs a watch in a process group of its own, so the timeout ends all of a pipeline and what it
// started (runGroup).
export function shell(
  cmd: string,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  timeoutMs = WATCH_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return runGroup(['sh', '-c', cmd], { cwd, env, timeoutMs })
}

const tickPath = (home: string): string => join(home, 'tick.ts')
const envPath = (home: string): string => join(home, 'schedule.json')
const cronTitle = (home: string): string => `nod-tick-${homeId(home)}`

export const SCHEDULE_OFF =
  'the schedule is off, so nothing runs it yet: turn it on with `nod schedule on`'

// The environment the tick runs in, fixed when the schedule was turned on; null while it is off.
export function scheduleEnv(home: string): Record<string, string> | null {
  const path = envPath(home)
  if (!existsSync(path)) return null
  return z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(path, 'utf8')))
}

// Registers the every-minute tick with the OS scheduler. The scheduler starts it with a bare
// environment, so it brings this shell's PATH (tmux, claude, git) and Claude config dir, which the
// watches and the workers it restarts use, unless an account rule names theirs (account.ts), and
// what else a worker gets of it but secrets and the SSH agent (savedEnv: proxies, locale, TMUX_TMPDIR
// so the tick finds the same tmux server); turning it on again replaces them. It stays on, whether
// or not anything is due, until turned off: a tick with nothing to do ends at once.
export async function scheduleOn(home: string): Promise<void> {
  const env: Record<string, string> = {
    ...savedEnv(),
    NOD_HOME: home,
    PATH: process.env.PATH ?? '',
  }
  if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
  writeFileSync(envPath(home), `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 })
  // The mode applies only to a new file, and an earlier nod wrote this one readable by all.
  chmodSync(envPath(home), 0o600)
  writeFileSync(tickPath(home), tickModule(home))
  try {
    await Bun.cron(tickPath(home), '* * * * *', cronTitle(home))
  } catch (error) {
    // The files are what says the schedule is on, and a tick registered before would run the
    // missing tick.ts every minute, so it goes too; the error to show is the registration's.
    rmSync(tickPath(home), { force: true })
    rmSync(envPath(home), { force: true })
    await Bun.cron.remove(cronTitle(home)).catch(() => {})
    throw error
  }
}

export async function scheduleOff(home: string): Promise<void> {
  await Bun.cron.remove(cronTitle(home))
  rmSync(tickPath(home), { force: true })
  rmSync(envPath(home), { force: true })
}

function tickModule(home: string): string {
  return `// Written by \`nod schedule on\`; the OS scheduler runs it every minute.
import env from ${JSON.stringify(envPath(home))}
import { tickHome } from ${JSON.stringify(join(import.meta.dir, 'triggers.ts'))}

export default {
  async scheduled() {
    Object.assign(process.env, env)
    await tickHome(${JSON.stringify(home)})
  },
}
`
}

export async function tickHome(home: string): Promise<void> {
  const ledger = new Ledger(home)
  const now = new Date()
  const watches = now.getMinutes() % WATCH_EVERY_MINUTES === 0
  const { passed, collected, lost, cut, restarted, closed } = await tick(
    ledger,
    home,
    Tmux.of(home),
    now,
    watches,
  )
  const at = new Date().toISOString()
  const tasks = (ids: number[]): string => ids.map((id) => `n${id}`).join(', ')
  if (passed.length > 0)
    console.log(`${at} watch passed: ${passed.map((id) => `t${id}`).join(', ')}`)
  if (collected.length > 0) console.log(`${at} collected task(s) ${tasks(collected)}`)
  if (lost.length > 0) console.log(`${at} turn(s) lost with their terminal: ${tasks(lost)}`)
  if (cut.length > 0) console.log(`${at} went on from a check cut off: ${tasks(cut)}`)
  if (restarted.length > 0) console.log(`${at} restarted task(s) ${tasks(restarted)}`)
  if (closed.length > 0) console.log(`${at} closed the terminal(s) of task(s) ${tasks(closed)}`)
}
