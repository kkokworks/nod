// Prints the line an unattended tomorrow prep's trigger source gives its worker (tomorrow.md): the
// next workday, a tab, then as JSON what the worker needs. The worker's sandbox keeps it from the
// ledger and the work tools, so this reads them outside it: that day in nod, the trust numbers, the
// open todos, and the output of each work tool that is on and has a script.
// Usage: bun <skill folder>/tomorrow.ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { localDay, nextWorkday } from '../../src/days'
import { loadConfig } from './sources/config'

const CLI = join(import.meta.dir, '..', '..', 'src', 'cli.ts')

// A tool that fails fails the whole line: a prep missing one tool would look complete.
function run(cmd: string[]): string {
  const result = Bun.spawnSync(cmd, { stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString()
}
const nod = (...args: string[]): string => run([process.execPath, CLI, ...args])

const day = nextWorkday(localDay(new Date()))
const sources = Object.fromEntries(
  (await loadConfig()).sources.flatMap((name) => {
    const script = join(import.meta.dir, 'sources', name, `${name}.ts`)
    return existsSync(script) ? [[name, run([process.execPath, script])]] : []
  }),
)
const data = {
  day,
  today: nod('today', day),
  trust: JSON.parse(nod('todo', 'check', '--json')),
  todos: nod('todo', '--json')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line)),
  sources,
}
console.log(`${day}\t${JSON.stringify(data)}`)
