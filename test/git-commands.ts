import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { git } from './remote'

// Commands for a git config to name, for the tests that nod's git outside the sandbox runs none
// (NOD_GIT in src/branch.ts): each leaves a mark under `dir` as it runs, then fails. `ran` lists the
// marks left, and `forget` takes them away.
export function marking(dir: string): {
  command: (name: string) => string
  ran: () => string[]
  forget: () => void
} {
  const bin = join(dir, 'bin')
  const marks = join(dir, 'marks')
  mkdirSync(bin, { recursive: true })
  mkdirSync(marks, { recursive: true })
  return {
    command: (name) => {
      const file = join(bin, name)
      writeFileSync(file, `#!/bin/sh\ntouch '${join(marks, name)}'\nexit 1\n`)
      chmodSync(file, 0o755)
      return file
    },
    ran: () => readdirSync(marks).sort(),
    forget: () => {
      for (const mark of readdirSync(marks)) rmSync(join(marks, mark))
    },
  }
}

// Submodules a worker made in its worktree `ws`, as its sandbox lets it: the sandbox refuses a
// .git/config anywhere, so each one's git folder has another name and a .git file points at it.
// Their config names commands from `command`: `a`'s a file system monitor and a hooks folder, with a
// file in its index that git status looks at again, so it writes the index (the hook); `b`'s the
// upload-pack that a lazy fetch of an object it lacks runs, with a staged rename to that object, so
// git status fetches it, and fails.
export function workerSubmodules(ws: string, command: (name: string) => string): void {
  const made = (name: string): string => {
    const sub = join(ws, name)
    git(ws, 'init', '-q', `--separate-git-dir=${join(ws, `${name}-git`)}`, sub)
    writeFileSync(join(sub, 'f'), 'a\n')
    git(sub, 'add', 'f')
    git(sub, 'commit', '-q', '-m', name)
    git(ws, 'add', name)
    git(ws, 'commit', '-q', '-m', `submodule ${name}`)
    return sub
  }
  // Last, as git would run what it names from then on.
  const configure = (sub: string, config: Record<string, string>): void => {
    for (const [key, value] of Object.entries(config)) git(sub, 'config', key, value)
  }
  const a = made('a')
  git(a, 'update-index', '--cacheinfo', `100644,${git(a, 'rev-parse', 'HEAD:f')},f`)
  configure(a, {
    'core.fsmonitor': command('fsmonitor'),
    'core.hooksPath': dirname(command('post-index-change')),
  })
  const b = made('b')
  git(b, 'rm', '-q', '--cached', 'f')
  const lacking = '0123456789012345678901234567890123456789'
  git(b, 'update-index', '--add', '--cacheinfo', `100644,${lacking},g`)
  configure(b, {
    'core.repositoryformatversion': '1',
    'extensions.partialClone': 'origin',
    'remote.origin.url': ws,
    'remote.origin.promisor': 'true',
    'remote.origin.uploadpack': command('upload-pack'),
  })
}

// A submodule `t` a worker made in `ws`, as workerSubmodules makes one, whose config names a
// textconv for its files, and two commits on the branch checked out in `ws` that add it and move it:
// a diff of them under diff.submodule=diff diffs in it.
export function textconvSubmodule(ws: string, command: (name: string) => string): void {
  const sub = join(ws, 't')
  git(ws, 'init', '-q', `--separate-git-dir=${join(ws, 't-git')}`, sub)
  writeFileSync(join(sub, '.gitattributes'), '* diff=x\n')
  writeFileSync(join(sub, 'f'), 'a\n')
  git(sub, 'add', '-A')
  git(sub, 'commit', '-q', '-m', 'one')
  git(ws, 'add', 't')
  git(ws, 'commit', '-q', '-m', 'submodule t')
  writeFileSync(join(sub, 'f'), 'b\n')
  git(sub, 'commit', '-q', '-am', 'two')
  git(ws, 'add', 't')
  git(ws, 'commit', '-q', '-m', 'move t')
  git(sub, 'config', 'diff.x.textconv', command('textconv'))
  // Its git folder untracked but ignored, so the worktree reads as committed.
  appendFileSync(resolve(ws, git(ws, 'rev-parse', '--git-path', 'info/exclude')), '/t-git/\n')
}

// Hooks from `command` in `dir`'s .husky/_, the hooks folder that a repo whose config says
// core.hooksPath=.husky/_ (husky's) names in each worktree.
export function huskyHooks(dir: string, command: (name: string) => string): string {
  const hooks = join(dir, '.husky', '_')
  mkdirSync(hooks, { recursive: true })
  for (const hook of ['post-checkout', 'post-index-change', 'reference-transaction']) {
    copyFileSync(command(hook), join(hooks, hook))
    chmodSync(join(hooks, hook), 0o755)
  }
  return hooks
}
