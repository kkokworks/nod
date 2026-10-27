import { mkdtempSync, rmSync } from 'node:fs'
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
// NOD_SOCKETS (socketsDir in worker.ts); anywhere else the temp dir. Not that folder outside the
// sandbox, where nod's check runs these tests: the worker writes the folder, and a link it left
// there would lead the check, ending the tmux servers of runs that are over (test/tmux.ts), to
// nod's own.
export const socketsParent = (env: Record<string, string | undefined> = process.env): string =>
  (env.SANDBOX_RUNTIME === '1' && env.NOD_SOCKETS) || tmpdir()
