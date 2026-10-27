import { test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { socketsParent } from './tmp'

// A stand-in for a Claude Code session's inbox socket: it reads the lines written into it, as JSON,
// and answers nothing, as Claude Code does. No test starts a real Claude Code session. `received`:
// settles once it has read `n` lines, which a send that is done may not have reached yet.
export type InboxServer = {
  lines: unknown[]
  received: (n: number) => Promise<void>
  close: () => Promise<void>
}

export function inboxServer(path: string): Promise<InboxServer> {
  const lines: unknown[] = []
  const waits: { n: number; done: () => void }[] = []
  const server: Server = createServer((conn) => {
    let read = ''
    conn.on('data', (chunk) => {
      read += String(chunk)
      for (let end = read.indexOf('\n'); end !== -1; end = read.indexOf('\n')) {
        lines.push(JSON.parse(read.slice(0, end)))
        read = read.slice(end + 1)
      }
      for (const w of waits.filter((w) => lines.length >= w.n)) w.done()
    })
  })
  const received = (n: number): Promise<void> =>
    lines.length >= n ? Promise.resolve() : new Promise((done) => waits.push({ n, done }))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () =>
      resolve({ lines, received, close: () => new Promise((done) => server.close(() => done())) }),
    )
  })
}

// Why to skip the tests that need a socket server, or null to run them, as tmuxSkip does: a Claude
// Code worker's sandbox refuses to listen on a Unix socket (EPERM, measured on 2.1.310), and its
// commands have SANDBOX_RUNTIME=1. Anything else that keeps the server from listening fails the
// run: nod's check runs these tests outside the sandbox and must not pass without them. As with
// tmuxSkip, a worker nod starts now listens in its own folder (NOD_SOCKETS), so they run there too.
export function inboxSkip(
  error: { code?: unknown } | null,
  env: Record<string, string | undefined>,
): string | null {
  if (error === null) return null
  if (env.SANDBOX_RUNTIME === '1' && error.code === 'EPERM') {
    return "this sandbox cannot listen on a Unix socket: skipping the tests that need one, which nod's check runs outside it"
  }
  throw new Error(`cannot listen on a Unix socket: ${String(error)}`)
}

async function probe(): Promise<{ code?: unknown } | null> {
  const dir = mkdtempSync(join(socketsParent(), 'nod-inbox-probe-'))
  try {
    const server = await inboxServer(join(dir, 's'))
    await server.close()
    return null
  } catch (error) {
    return error as { code?: unknown }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const inboxSkipped = inboxSkip(await probe(), process.env)
if (inboxSkipped !== null) console.warn(inboxSkipped)

// For a test that needs a socket server: skipped where `inboxSkip` says so.
export const inboxTest = test.skipIf(inboxSkipped !== null)
