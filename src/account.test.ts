import { afterAll, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { accountChanged, accountRule, configDir, setAccountRule } from './account'

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
