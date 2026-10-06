import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Temp dirs a test file removes when it is done: `const tmp = tempDirs(); afterAll(tmp.removeAll)`.
export function tempDirs(): { make: (prefix: string) => string; removeAll: () => void } {
  const made: string[] = []
  return {
    make: (prefix) => {
      const dir = mkdtempSync(join(tmpdir(), prefix))
      made.push(dir)
      return dir
    },
    removeAll: () => {
      for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
    },
  }
}
