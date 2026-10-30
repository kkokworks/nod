// Running commands for nod: in a process group of their own (runGroup, spawn), several at once
// (readAtOnce), and what goes into a message of their output and errors. It uses no other nod
// module, so any of them can.

// How long a run waits, once its process has ended, for its output to close.
const OUTPUT_GRACE_MS = 500

// The groups of the commands running now (runGroup). Out of this process's group, they would outlive
// a signal that ends it, and their limit with it: a Stop hook's check ran on after its session
// closed (review). Such a signal goes to them first, as it did in this process's group.
const running = new Set<number>()
const ENDING = ['SIGHUP', 'SIGTERM', 'SIGINT'] as const

function killGroup(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // The group has ended already.
  }
}

function endRunning(signal: NodeJS.Signals): void {
  // A process with a handler of its own decides what the signal ends (the keeper ignores Ctrl-C),
  // and one in the middle of unbroken work ends once that is done.
  if (process.listenerCount(signal) > 1) return
  end(signal)
}

function end(signal: NodeJS.Signals): void {
  // The signal itself, not SIGKILL, so git removes its lock as it goes (review).
  for (const pid of running) killGroup(pid, signal)
  running.clear()
  for (const s of ENDING) process.off(s, endRunning)
  // The process ends on the signal, as it did without this handler.
  process.kill(process.pid, signal)
}

// Work that must not stop halfway: a send of notices marked sent before it goes (inbox.ts), which
// a hook nod ends by closing its terminal would otherwise lose. A signal that would end this
// process meanwhile ends it once the work is done, which the work's own limit bounds. One the
// process has a handler of its own for went to that handler, as ever.
let unbrokenRuns = 0
let held: NodeJS.Signals | null = null
const hold = (signal: NodeJS.Signals): void => {
  held ??= signal
}

export async function unbroken<T>(work: () => Promise<T>): Promise<T> {
  if (unbrokenRuns++ === 0) for (const s of ENDING) process.on(s, hold)
  try {
    return await work()
  } finally {
    // A signal that came as the work ended is heard before the handler goes.
    await new Promise((resolve) => setImmediate(resolve))
    if (--unbrokenRuns === 0) {
      for (const s of ENDING) process.off(s, hold)
      const signal = held
      held = null
      // Past endRunning, there while commands run.
      const own = signal !== null && process.listenerCount(signal) > (running.size > 0 ? 1 : 0)
      if (signal !== null && !own) end(signal)
    }
  }
}

// Runs a command in a process group of its own, so the timeout ends all of a pipeline: killing only
// the first process leaves the rest holding its output open, and the wait goes on (measured). Once
// the command has ended, killed or not, what still holds its output (one it put in the background,
// one that left the group with setsid and outlived the kill) is not waited for past a short grace:
// the run returns what it read by then, and what was left keeps running. The sources and watches
// (shell) and the worker's commands (spawn) run here too.
export async function runGroup(
  cmd: string[],
  opts: {
    cwd?: string
    env: Record<string, string | undefined>
    stdin?: string
    // Without it, the command is not killed.
    timeoutMs?: number
    // How long output is waited on once the command has ended; a test sets it.
    graceMs?: number
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })
  if (running.size === 0) for (const s of ENDING) process.on(s, endRunning)
  running.add(proc.pid)
  // Readers, not Response.text(): a read that is let go must be cancelled, or Bun stays up until the
  // process holding the pipe ends (measured). What each has read is kept as it comes.
  const read = { stdout: '', stderr: '' }
  const readers = { stdout: proc.stdout.getReader(), stderr: proc.stderr.getReader() }
  const output = Promise.all(
    (['stdout', 'stderr'] as const).map(async (key) => {
      const decoder = new TextDecoder()
      for (let r = await readers[key].read(); !r.done; r = await readers[key].read()) {
        read[key] += decoder.decode(r.value, { stream: true })
      }
      read[key] += decoder.decode()
    }),
  )
  const timer =
    opts.timeoutMs === undefined ? undefined : setTimeout(() => killGroup(proc.pid), opts.timeoutMs)
  let grace: ReturnType<typeof setTimeout> | undefined
  try {
    const code = await proc.exited
    // Ended in time, it is not killed while its output is waited on, nor is what it left.
    clearTimeout(timer)
    running.delete(proc.pid)
    if (running.size === 0) for (const s of ENDING) process.off(s, endRunning)
    await Promise.race([
      output,
      new Promise((resolve) => {
        grace = setTimeout(resolve, opts.graceMs ?? OUTPUT_GRACE_MS)
      }),
    ])
    return { code, ...read }
  } finally {
    clearTimeout(timer)
    clearTimeout(grace)
    await Promise.all([readers.stdout.cancel(), readers.stderr.cancel()])
  }
}

// `output` is stdout followed by stderr; their interleaving is lost. A command still running after
// `timeoutMs` is killed with what it started (runGroup) and exits nonzero.
export async function spawn(
  cmd: string[],
  cwd?: string,
  opts: { stdin?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; output: string }> {
  const { code, stdout, stderr } = await runGroup(cmd, {
    cwd,
    env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs,
  })
  return { code, stdout, output: stdout + stderr }
}

// How many tasks ls and doneTasks read at once, each running a command at a time: all of a long
// ledger at once runs out of processes (a crash with EAGAIN under `ulimit -u`, measured), and takes
// them from everything else the user runs.
export const AT_ONCE = 8

// `read` of each item, `AT_ONCE` at a time, in the items' order. Once one fails no more start,
// and it rejects as reading them in turn would: with the failure of the first item that failed.
export async function readAtOnce<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  const failed: { i: number; error: unknown }[] = []
  let next = 0
  const reader = async (): Promise<void> => {
    for (let i = next++; i < items.length && failed.length === 0; i = next++) {
      try {
        out[i] = await read(items[i] as T)
      } catch (error) {
        failed.push({ i, error })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, reader))
  const first = failed.toSorted((a, b) => a.i - b.i)[0]
  if (first !== undefined) throw first.error
  return out
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// How much of a command's output, its end, goes into a message.
export const OUTPUT_LIMIT = 4000
