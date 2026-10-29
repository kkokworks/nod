import { mkdtempSync, realpathSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Temp dirs a test file removes when it is done: `const tmp = tempDirs(); afterAll(tmp.removeAll)`.
// `parent`: where to make one, the temp dir unless said.
export function tempDirs(): {
  make: (prefix: string, parent?: string) => string
  removeAll: () => void
} {
  const made: string[] = []
  return {
    make: (prefix, parent = tmpdir()) => {
      const dir = mkdtempSync(join(parent, prefix))
      made.push(dir)
      return dir
    },
    removeAll: () => {
      for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
    },
  }
}

// Where a test makes the dirs it keeps Unix sockets in (a tmux server's, a socket it listens on):
// inside a nod worker's sandbox, the one folder it lets the worker keep them in, which nod names in
// NOD_SOCKETS (socketsDir in place.ts); anywhere else the temp dir. Not that folder outside the
// sandbox, where nod's check runs these tests: the worker writes the folder, and a link it left
// there would lead the check, ending the tmux servers of runs that are over (test/tmux.ts), to
// nod's own. Nor in a sandbox that does not let this process make dirs there (nod's reviewer gets
// the worker's NOD_SOCKETS with a sandbox of its own), nor in one whose path leaves too little of a
// socket path's 104 bytes (macOS, with its NUL) for what the tests put past it: there the tests
// skip as before.
// `tail`: what the tests put past it.
export function socketsParent(
  env: Record<string, string | undefined> = process.env,
  tail = SOCKET_TAIL,
): string {
  const dir = env.SANDBOX_RUNTIME === '1' ? env.NOD_SOCKETS : undefined
  return dir && usable(dir, tail) ? dir : tmpdir()
}

// The most a test puts past it, as tmux has it (past the real path): worker.test.ts's
// `/nod-tmux-XXXXXX/tmux-<uid>/nod-<home hash>`, 43 bytes with a three-digit uid, and room for a
// longer one.
const SOCKET_TAIL = 50

function usable(dir: string, tail: number): boolean {
  try {
    if (Buffer.byteLength(realpathSync(dir)) + tail > 103) return false
    rmdirSync(mkdtempSync(join(dir, 'nod-try-')))
    return true
  } catch {
    return false
  }
}
