import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { collect, sessionFolder } from './gc'
import { Ledger } from './ledger'
import { workspaceOf } from './worker'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const OLD = '2026-01-01T00:00:00.000Z'

test('gc removes old finished workspaces and their session folders, and keeps the rest', async () => {
  const home = tmp.make('nod-gc-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-gc-claude-')
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  sh(['git', 'init', '-q'], repo)
  sh(
    [
      'git',
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ],
    repo,
  )

  const task = (brief: string, withRepo: boolean, finishedAt: string): number => {
    const id = ledger.add({
      brief,
      repo: withRepo ? repo : null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    })
    const cwd = workspaceOf(home, id)
    if (withRepo) sh(['git', 'worktree', 'add', '-q', '-b', `nod/${id}`, cwd], repo)
    else mkdirSync(cwd, { recursive: true })
    mkdirSync(sessionFolder(cwd), { recursive: true })
    ledger.setRunning(id, cwd)
    ledger.succeed(id)
    ledger.db.query('update tasks set finished_at = $at where id = $id').run({ id, at: finishedAt })
    return id
  }
  const oldPlain = task('old plain', false, OLD)
  const oldRepo = task('old repo', true, OLD)
  const dirty = task('old dirty repo', true, OLD)
  writeFileSync(join(workspaceOf(home, dirty), 'uncommitted.txt'), 'x')
  const recent = task('recent', false, new Date().toISOString())
  const recentSessions = sessionFolder(workspaceOf(home, recent))
  const oldPlainSessions = sessionFolder(workspaceOf(home, oldPlain))

  const report = await collect(ledger, home, { before: new Date(Date.now() - 7 * 86_400_000) })

  expect(report).toEqual({
    removed: [oldPlain, oldRepo],
    skipped: [{ id: dirty, reason: 'uncommitted changes in worktree' }],
  })
  expect(existsSync(workspaceOf(home, oldPlain))).toBe(false)
  expect(existsSync(oldPlainSessions)).toBe(false)
  expect(existsSync(workspaceOf(home, oldRepo))).toBe(false)
  expect(sh(['git', 'branch', '--list', `nod/${oldRepo}`], repo)).toContain(`nod/${oldRepo}`)
  expect(existsSync(workspaceOf(home, dirty))).toBe(true)
  expect(existsSync(workspaceOf(home, recent))).toBe(true)
  expect(existsSync(recentSessions)).toBe(true)
  expect(ledger.list()).toHaveLength(4)
})

test('gc collects the tasks the human names, however recent, and leaves unfinished ones', async () => {
  const home = tmp.make('nod-gc-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-gc-claude-')
  const ledger = new Ledger(home)
  const task = (brief: string): number => {
    const id = ledger.add({
      brief,
      repo: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    })
    mkdirSync(workspaceOf(home, id), { recursive: true })
    ledger.setRunning(id, workspaceOf(home, id))
    return id
  }
  const named = task('named')
  ledger.succeed(named)
  const other = task('other')
  ledger.succeed(other)
  const running = task('running')

  const report = await collect(ledger, home, { ids: [named, running] })

  expect(report).toEqual({ removed: [named], skipped: [{ id: running, reason: 'still running' }] })
  expect(existsSync(workspaceOf(home, named))).toBe(false)
  expect(existsSync(workspaceOf(home, other))).toBe(true)
  expect(existsSync(workspaceOf(home, running))).toBe(true)
})

function sh(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}
