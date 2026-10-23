import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tempDirs } from '../../test/tmp'

const tmp = tempDirs()
afterAll(tmp.removeAll)

// Installs into an empty home with bun, plutil and launchctl stood in for, so nothing is built or
// loaded; each stand-in writes what it was asked to the calls file.
function install(savedEnv: { exit: number; out: string }) {
  const home = tmp.make('nod-ui-sh-')
  const bin = `${home}/bin`
  mkdirSync(bin)
  const stub = (name: string, body: string) => {
    writeFileSync(`${bin}/${name}`, `#!/bin/sh\necho "${name} $*" >> "$HOME/calls"\n${body}\n`)
    chmodSync(`${bin}/${name}`, 0o755)
  }
  stub('bun', `[ "$1" = -e ] && { printf '${savedEnv.out}'; exit ${savedEnv.exit}; }; exit 0`)
  stub('plutil', 'exit 0')
  stub('launchctl', 'exit 0')
  const run = Bun.spawnSync(['sh', `${import.meta.dir}/ui.sh`, 'install'], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: home },
  })
  const calls = existsSync(`${home}/calls`) ? readFileSync(`${home}/calls`, 'utf8') : ''
  // The script's temp files, which it must not leave behind.
  const left = readdirSync(home).filter((name) => name.startsWith('nod-ui-env'))
  return { exitCode: run.exitCode, calls, left }
}

test('the install fails, and loads no agent, when reading the environment for workers fails', () => {
  const failed = install({ exit: 1, out: '' })
  expect(failed.exitCode).not.toBe(0)
  expect(failed.calls).not.toContain('launchctl')
  expect(failed.left).toEqual([])

  const ok = install({ exit: 0, out: 'HTTPS_PROXY\\thttp://proxy.example\\n' })
  expect(ok.exitCode).toBe(0)
  expect(ok.calls).toContain(
    '-replace EnvironmentVariables.HTTPS_PROXY -string http://proxy.example',
  )
  expect(ok.calls).toContain('launchctl bootstrap')
  expect(ok.left).toEqual([])
})
