import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

// Which Claude account a worker runs as: the Claude Code config dir it gets in CLAUDE_CONFIG_DIR.
// Without a rule, the one in the environment of whoever starts the worker, as before rules existed.
// A tool that switches accounts keeps the current one somewhere; a rule reads it from there, so
// every worker nod starts or starts again (worker.ts) gets the account that is current at that
// moment, and nod can tell a worker that runs as another one.

const TIMEOUT_MS = 10_000

const Rule = z.union([
  z.object({ file: z.string().min(1) }).strict(),
  z.object({ command: z.string().min(1) }).strict(),
])
// null: the environment's CLAUDE_CONFIG_DIR.
export type AccountRule = z.infer<typeof Rule> | null

const rulePath = (home: string): string => join(home, 'account.json')

export function accountRule(home: string): AccountRule {
  const path = rulePath(home)
  if (!existsSync(path)) return null
  return Rule.parse(JSON.parse(readFileSync(path, 'utf8')))
}

export function setAccountRule(home: string, rule: AccountRule): void {
  if (rule === null) rmSync(rulePath(home), { force: true })
  else writeFileSync(rulePath(home), `${JSON.stringify(rule, null, 2)}\n`)
}

// The CLAUDE_CONFIG_DIR a worker starting now gets; null for none. A file or command that gives
// nothing means none too, so Claude Code uses its default folder. One that cannot be read throws:
// starting a worker as some other account is worse than not starting it.
export function configDir(home: string): string | null {
  const rule = accountRule(home)
  if (rule === null) return process.env.CLAUDE_CONFIG_DIR || null
  if ('file' in rule) return readFileSync(rule.file, 'utf8').trim() || null
  const run = Bun.spawnSync(['sh', '-c', rule.command], {
    cwd: home,
    env: process.env,
    stdin: 'ignore',
    timeout: TIMEOUT_MS,
  })
  if (run.exitCode !== 0) {
    throw new Error(
      `the account command \`${rule.command}\` exited ${run.exitCode}: ${run.stderr.toString().trim()}`,
    )
  }
  return run.stdout.toString().trim() || null
}

// Whether `account`, what a worker started with ('' for none), is no longer the current one. Only a
// rule says what is current for every worker; without one each started from its own shell.
export function accountChanged(home: string, account: string | null): boolean {
  if (account === null || accountRule(home) === null) return false
  return (configDir(home) ?? '') !== account
}

export function describeRule(rule: AccountRule): string {
  if (rule === null) return 'env: CLAUDE_CONFIG_DIR of the shell that starts each worker'
  return 'file' in rule ? `file ${rule.file}` : `command ${rule.command}`
}
