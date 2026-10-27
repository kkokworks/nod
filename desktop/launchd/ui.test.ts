import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tempDirs } from '../../test/tmp'

const tmp = tempDirs()
afterAll(tmp.removeAll)
// An install runs a few dozen stand-ins, under half a second each here; checks run under load.
setDefaultTimeout(20_000)

// Installs into an empty home, from a copy of the script in a repo of its own (the install swaps
// ui/dist), with bun, plutil, launchctl, curl and sleep stood in for, so nothing is built, loaded,
// asked or waited on; each stand-in writes what it was asked to the calls file. By default the
// server answers once the agent is bootstrapped.
function install({
  savedEnv = { exit: 0, out: '' },
  launchctl = 'exit 0',
  curl = 'grep -q "launchctl bootstrap" "$HOME/calls" && exit 0; exit 7',
}: {
  savedEnv?: { exit: number; out: string }
  launchctl?: string
  curl?: string
} = {}) {
  const home = tmp.make('nod-ui-sh-')
  const bin = `${home}/bin`
  const repo = `${home}/repo`
  for (const dir of [bin, `${repo}/desktop/launchd`, `${repo}/ui/dist`, `${repo}/src`]) {
    mkdirSync(dir, { recursive: true })
  }
  for (const name of ['ui.sh', 'nod-ui.plist']) {
    copyFileSync(`${import.meta.dir}/${name}`, `${repo}/desktop/launchd/${name}`)
  }
  writeFileSync(`${repo}/ui/dist/old`, '')
  mkdirSync(`${home}/Library/Logs`, { recursive: true })
  writeFileSync(`${home}/Library/Logs/nod-ui.log`, 'error: Port 4800 is already in use\n')
  const stub = (name: string, body: string) => {
    writeFileSync(`${bin}/${name}`, `#!/bin/sh\necho "${name} $*" >> "$HOME/calls"\n${body}\n`)
    chmodSync(`${bin}/${name}`, 0o755)
  }
  stub(
    'bun',
    `[ "$1" = -e ] && { printf '${savedEnv.out}'; exit ${savedEnv.exit}; }
[ "$1" = run ] && mkdir -p "$4"; exit 0`,
  )
  stub('plutil', 'exit 0')
  stub('launchctl', launchctl)
  stub('curl', curl)
  stub('sleep', 'exit 0')
  const run = Bun.spawnSync(['sh', `${repo}/desktop/launchd/ui.sh`, 'install'], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: home },
  })
  const calls = existsSync(`${home}/calls`) ? readFileSync(`${home}/calls`, 'utf8') : ''
  // The script's temp files, which it must not leave behind.
  const left = readdirSync(home).filter((name) => name.startsWith('nod-ui-'))
  const agent = existsSync(`${home}/Library/LaunchAgents/io.github.kkokworks.nod.ui.plist`)
  const dist = readdirSync(`${repo}/ui`).flatMap((name) =>
    name.startsWith('dist') ? [`${name}:${readdirSync(`${repo}/ui/${name}`).join(',')}`] : [],
  )
  return { exitCode: run.exitCode, stderr: run.stderr.toString(), calls, left, agent, dist }
}

test('the install fails, and loads no agent, when reading the environment for workers fails', () => {
  const failed = install({ savedEnv: { exit: 1, out: '' } })
  expect(failed.exitCode).not.toBe(0)
  expect(failed.calls).not.toContain('launchctl')
  expect(failed.left).toEqual([])
  // Nor a half-made agent for the next login to load.
  expect(failed.agent).toBe(false)

  const ok = install({ savedEnv: { exit: 0, out: 'HTTPS_PROXY\\thttp://proxy.example\\n' } })
  expect(ok.exitCode).toBe(0)
  expect(ok.calls).toContain(
    '-replace EnvironmentVariables.HTTPS_PROXY -string http://proxy.example',
  )
  expect(ok.calls).toContain('launchctl bootstrap')
  expect(ok.left).toEqual([])
  expect(ok.agent).toBe(true)
})

test('the build goes beside dist/ and replaces it whole, not in place', () => {
  const ok = install()
  expect(ok.exitCode).toBe(0)
  expect(ok.calls).toContain('bun run build --outDir dist.next')
  // The old build is gone and the new one, empty from the stand-in, has its place.
  expect(ok.dist).toEqual(['dist:'])
})

test('a bootstrap that fails right after the bootout is tried again', () => {
  const ok = install({
    launchctl: `[ "$1" = bootstrap ] && [ ! -e "$HOME/failed" ] && { touch "$HOME/failed"; echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5; }
exit 0`,
  })
  expect(ok.exitCode).toBe(0)
  expect(ok.calls.match(/launchctl bootstrap/g)?.length).toBe(2)

  const failed = install({ launchctl: '[ "$1" = bootstrap ] && exit 5; exit 0' })
  expect(failed.exitCode).not.toBe(0)
})

test('the install fails, without loading the agent, while another server holds the port', () => {
  const taken = install({ curl: 'exit 0' })
  expect(taken.exitCode).not.toBe(0)
  expect(taken.calls).not.toContain('launchctl bootstrap')
  expect(taken.stderr).toContain('another server answers on http://127.0.0.1:4800')
  // Asked directly: a proxy in the shell's environment would answer for a free port.
  expect(taken.calls).toContain(
    'curl -s -o /dev/null --max-time 1 --noproxy * http://127.0.0.1:4800',
  )
})

test('the install fails, showing the end of the log, when the server does not come up', () => {
  const down = install({ curl: 'exit 7' })
  expect(down.exitCode).not.toBe(0)
  expect(down.calls).toContain('launchctl bootstrap')
  expect(down.stderr).toContain('did not answer')
  expect(down.stderr).toContain('error: Port 4800 is already in use')
})
