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
// the one folder a nod worker's sandbox lets it keep them in, which nod names in NOD_SOCKETS
// (socketsDir in worker.ts), or else the temp dir.
export const socketsParent = (): string => process.env.NOD_SOCKETS || tmpdir()
