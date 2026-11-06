import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { accountChanged, accountRule, configDir, openedIn, setAccountRule } from './account'

const tmp = tempDirs()
afterAll(tmp.removeAll)

test("without a rule a worker gets the environment's config dir; a rule reads a file or a command, and nothing there means none", () => {
  const home = tmp.make('nod-account-')
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = '/from/env'
  try {
    expect(accountRule(home)).toBeNull()
    expect(configDir(home)).toBe('/from/env')
    // Without a rule each worker runs as the shell that started it; none is out of date.
    expect(accountChanged(home, '/elsewhere')).toBe(false)

    const current = join(home, 'current')
    writeFileSync(current, '  /accounts/b\n')
    setAccountRule(home, { file: current })
    expect(configDir(home)).toBe('/accounts/b')
    expect(accountChanged(home, '/accounts/a')).toBe(true)
    expect(accountChanged(home, '/accounts/b')).toBe(false)
    // A terminal that does not record its account cannot be compared.
    expect(accountChanged(home, null)).toBe(false)
    writeFileSync(current, '\n')
    expect(configDir(home)).toBeNull()
    expect(accountChanged(home, '')).toBe(false)

    setAccountRule(home, { command: 'echo /accounts/c' })
    expect(configDir(home)).toBe('/accounts/c')
    setAccountRule(home, { command: 'echo no account >&2; exit 3' })
    expect(() => configDir(home)).toThrow('exited 3: no account')
    setAccountRule(home, { file: join(home, 'missing') })
    expect(() => configDir(home)).toThrow('ENOENT')

    setAccountRule(home, null)
    expect(accountRule(home)).toBeNull()
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  }
})

test("a session's folder is the one its transcript's folder is named after, not where it stood last", () => {
  const config = tmp.make('nod-opened-')
  const keep = (folder: string, session: string, lines: unknown[]): void => {
    const path = join(config, 'projects', folder)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
  }
  expect(openedIn(config, 'none')).toBeNull()
  keep('-work-app', 'moved', [
    { type: 'title' },
    { type: 'user', cwd: '/work/app/src' },
    { type: 'user', cwd: '/work/app' },
    { type: 'user', cwd: '/elsewhere' },
  ])
  expect(openedIn(config, 'moved')).toBe('/work/app')
  // A folder name says only what its characters were: the line says which they are.
  keep('-work-my-app', 'dashed', [{ cwd: '/work/my.app' }])
  expect(openedIn(config, 'dashed')).toBe('/work/my.app')
  // A long path's folder is cut, with a hash after.
  const long = `/${'a'.repeat(300)}`
  keep(`-${'a'.repeat(199)}-1x2y3z`, 'long', [{ cwd: long }])
  expect(openedIn(config, 'long')).toBe(long)
  // A quote inside a path, and a transcript with no line of its folder.
  keep('-a-b', 'quoted', [{ cwd: '/a"b' }])
  expect(openedIn(config, 'quoted')).toBe('/a"b')
  keep('-other', 'unsaid', [{ cwd: '/work/app' }, { type: 'user' }])
  expect(openedIn(config, 'unsaid')).toBeNull()
})
