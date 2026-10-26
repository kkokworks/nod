import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// A fixed identity and no hooks, so commits do not depend on this machine's git config.
export const GIT = [
  'git',
  '-c',
  'user.name=nod test',
  '-c',
  'user.email=nod-test@example.invalid',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'commit.gpgsign=false',
]

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync([...GIT, ...args], { cwd })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

// Puts the fake gh and tea (fake-git-service.ts) first on PATH, keeping their state in `state`.
export function fakeService(bin: string, state: string): void {
  const fake = resolve(import.meta.dir, 'fake-git-service.ts')
  for (const tool of ['gh', 'tea']) {
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} ${tool} "$@"\n`,
    )
    chmodSync(join(bin, tool), 0o755)
  }
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.FAKE_SERVICE = state
  if (Bun.which('gh', { PATH: process.env.PATH }) !== join(bin, 'gh')) {
    throw new Error('fake gh is not first on PATH')
  }
}

// A repo cloned from a local bare one, whose origin says `url` as a git service knows it while git
// fetches from and pushes to the bare repo (`insteadOf`). The fake service merges in that bare repo.
export function clonedRepo(
  dir: (prefix: string) => string,
  state: string,
  url: string,
): { repo: string; origin: string } {
  const origin = dir('nod-origin-')
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  const seed = dir('nod-seed-')
  git(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'README'), 'readme\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-qm', 'init')
  git(seed, 'push', '-q', origin, 'main')
  const repo = dir('nod-clone-')
  git(repo, 'clone', '-q', origin, '.')
  git(repo, 'config', 'remote.origin.url', url)
  git(repo, 'config', `url.${origin}.insteadOf`, url)
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'origin'), origin)
  return { repo, origin }
}

export type Call = { tool: string; args: string[]; stdin: string }
export const calls = (state: string): Call[] => {
  try {
    return readFileSync(join(state, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l): Call => JSON.parse(l))
  } catch {
    return []
  }
}
