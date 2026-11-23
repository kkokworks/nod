import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { namedAfter } from './account'
import { jsonOrNull } from './report'

// The temp folder Claude Code keeps of each session (2.1.330): its scratchpad, the output of its
// background tasks. It is `<base>/claude-<uid>/<folder>/<session ID>`, with the folder named after
// the one the session was opened in (namedAfter), and Claude Code leaves it. gc removes a task's
// (gc.ts), and a review its own (verify.ts).

// The base where CLAUDE_CODE_TMPDIR names none. In the open so a test never looks in the real one.
export const TMP = { base: '/tmp' }

const Settings = z.object({ env: z.object({ CLAUDE_CODE_TMPDIR: z.string().min(1) }) })

// The folder Claude Code keeps the sessions' temp folders in, for those of the config dir `config`.
// Not by nod's own CLAUDE_CODE_TMPDIR: a worker does not get that (PASS_ENV in env.ts), but the one
// its account's settings set in `env`, which wins over its environment's (2.1.330, measured).
// ponytail: one set elsewhere (a repo's own settings, managed ones) is not read, and what is kept
// there stays; have the worker's hooks record theirs if that bites.
export function tmpRoot(config: string | null): string {
  const file = join(config ?? join(homedir(), '.claude'), 'settings.json')
  const json = existsSync(file) ? jsonOrNull(readFileSync(file, 'utf8')) : null
  const base = Settings.safeParse(json).data?.env.CLAUDE_CODE_TMPDIR ?? TMP.base
  // Through the base's own links (macOS has /tmp behind one).
  return join(existsSync(base) ? realpathSync(base) : base, `claude-${process.getuid?.()}`)
}

// Removes from `root` (tmpRoot) the temp folders of the sessions opened in `cwd`, a real path, that
// are `mine`, and the folder of `cwd` once that leaves it empty. Every other session's stays: the
// folder's name is the same for paths that differ only in `/`, `.` and the like, and a person may
// have opened a session in `cwd` too. Returns whether there was one; one it cannot remove does not
// keep the rest, and then it throws why. It goes through and removes folders only, never links: the
// root is the TMPDIR of every worker's sandbox, and a link one left there would lead nod, which has
// no sandbox, to what it points to. rmSync removes a link it finds inside, not what that points to:
// the output Claude Code keeps of a background agent is a link to its transcript. Each goes to a name
// of its own first (GONE), at once, as removing it may take seconds: what the worker of a task told
// to go on meanwhile writes is in a folder made anew. One a removal left under such a name goes too.
// ponytail: a link put in between the look and the rename is followed; only one to a folder that has
// a folder by that session's ID loses anything.
export function removeTmp(
  root: string,
  cwd: string,
  mine: (sessionId: string) => boolean,
): boolean {
  if (!isFolder(root)) return false
  let removed = false
  const failed: unknown[] = []
  for (const folder of readdirSync(root).filter((f) => namedAfter(f, cwd))) {
    const dir = join(root, folder)
    if (!isFolder(dir)) continue
    for (const name of readdirSync(dir)) {
      const at = join(dir, name)
      if (!isFolder(at) || !mine(name.replace(GONE, ''))) continue
      const gone = GONE.test(name) ? at : `${at}.gone-${crypto.randomUUID()}`
      try {
        if (gone !== at) renameSync(at, gone)
        rmSync(gone, { recursive: true })
        removed = true
      } catch (error) {
        // Gone otherwise: another gc took it.
        if (existsSync(at) || existsSync(gone)) failed.push(error)
      }
    }
    if (!removed) continue
    try {
      rmdirSync(dir)
    } catch {
      // Not empty: another session's, or one it could not remove.
    }
  }
  if (failed.length > 0) throw failed[0]
  return removed
}

const GONE = /\.gone-[0-9a-f-]{36}$/

const isFolder = (path: string): boolean =>
  lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
