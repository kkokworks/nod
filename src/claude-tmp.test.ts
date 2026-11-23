import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tempFolder } from '../test/projects'
import { tempDirs } from '../test/tmp'
import { removeTmp, TMP, tmpRoot } from './claude-tmp'

const tmp = tempDirs()
afterAll(tmp.removeAll)
const usual = { ...TMP }
afterEach(() => {
  Object.assign(TMP, usual)
})

const MINE = crypto.randomUUID()
const THEIRS = crypto.randomUUID()
const uid = `claude-${process.getuid?.()}`

// A session's temp folder of `cwd` under `base`, with a file in its scratchpad.
function temp(base: string, cwd: string, session: string): string {
  const dir = tempFolder(base, cwd, session)
  mkdirSync(join(dir, 'scratchpad'), { recursive: true })
  writeFileSync(join(dir, 'scratchpad', 'a.txt'), 'a')
  return dir
}

// A base with its root, and a folder sessions were opened in.
function place(): { base: string; root: string; cwd: string } {
  const base = realpathSync(tmp.make('nod-tmp-'))
  return { base, root: join(base, uid), cwd: realpathSync(tmp.make('nod-cwd-')) }
}
const mine = (id: string): boolean => id === MINE

test("the root is the account's settings' CLAUDE_CODE_TMPDIR, whatever nod's own, else the usual base", () => {
  const config = tmp.make('nod-config-')
  const was = process.env.CLAUDE_CODE_TMPDIR
  process.env.CLAUDE_CODE_TMPDIR = tmp.make('nod-own-')
  try {
    const real = realpathSync(tmp.make('nod-usual-'))
    const link = join(tmp.make('nod-link-'), 'tmp')
    symlinkSync(real, link)
    TMP.base = link
    // As macOS has /tmp, through which Claude Code looks.
    expect(tmpRoot(config)).toBe(join(real, uid))
    const set = realpathSync(tmp.make('nod-set-'))
    const settings = (text: string): void => writeFileSync(join(config, 'settings.json'), text)
    settings(JSON.stringify({ env: { CLAUDE_CODE_TMPDIR: set } }))
    expect(tmpRoot(config)).toBe(join(set, uid))
    // Settings that set nothing, or that do not read.
    for (const text of [
      '{"env":{"A":"b"}}',
      '{}',
      'not json',
      '{"env":{"CLAUDE_CODE_TMPDIR":""}}',
    ]) {
      settings(text)
      expect(tmpRoot(config)).toBe(join(real, uid))
    }
    // A base that is not there has nothing to remove.
    settings(JSON.stringify({ env: { CLAUDE_CODE_TMPDIR: join(set, 'gone') } }))
    expect(tmpRoot(config)).toBe(join(set, 'gone', uid))
    expect(removeTmp(tmpRoot(config), '/anywhere', () => true)).toBe(false)
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CODE_TMPDIR
    else process.env.CLAUDE_CODE_TMPDIR = was
  }
})

test("only the session's folder of the folder it was opened in goes, and that one once it is empty", () => {
  const { base, root, cwd } = place()
  const elsewhere = realpathSync(tmp.make('nod-cwd-'))
  const session = temp(base, cwd, MINE)
  const stays = [
    temp(base, cwd, THEIRS),
    temp(base, elsewhere, MINE),
    // Names that only begin as the folder's.
    join(`${dirname(session)}-more`, MINE),
  ]
  mkdirSync(stays[2] ?? '', { recursive: true })
  writeFileSync(join(root, 'a file'), '')

  expect(removeTmp(root, cwd, mine)).toBe(true)
  expect(existsSync(session)).toBe(false)
  expect(stays.map((s) => existsSync(s))).toEqual([true, true, true])
  expect(existsSync(join(root, 'a file'))).toBe(true)
  expect(removeTmp(root, cwd, mine)).toBe(false)

  expect(removeTmp(root, cwd, (id) => id === THEIRS)).toBe(true)
  expect(existsSync(dirname(session))).toBe(false)
})

test('a folder named after a path over 200 characters goes too', () => {
  const { base, root } = place()
  const cwd = join(realpathSync(tmp.make('nod-cwd-')), 'a'.repeat(100), 'b'.repeat(100))
  mkdirSync(cwd, { recursive: true })
  const session = temp(base, cwd, MINE)
  expect(basename(dirname(session)).length).toBeGreaterThan(200)
  expect(removeTmp(root, cwd, mine)).toBe(true)
  expect(existsSync(session)).toBe(false)
})

test('links in a session folder go, and what they point to stays', () => {
  const { base, root, cwd } = place()
  const outside = tmp.make('nod-outside-')
  mkdirSync(join(outside, 'dir'))
  writeFileSync(join(outside, 'dir', 'kept.txt'), 'kept')
  writeFileSync(join(outside, 'transcript.jsonl'), '{}')
  const session = temp(base, cwd, MINE)
  // As Claude Code keeps a background agent's output, and what a worker may link in its scratchpad.
  symlinkSync(join(outside, 'transcript.jsonl'), join(session, 'agent.output'))
  symlinkSync(join(outside, 'dir'), join(session, 'scratchpad', 'dir'))
  symlinkSync(join(outside, 'gone'), join(session, 'scratchpad', 'dangling'))

  expect(removeTmp(root, cwd, mine)).toBe(true)
  expect(existsSync(session)).toBe(false)
  expect(readdirSync(outside).sort()).toEqual(['dir', 'transcript.jsonl'])
  expect(readFileSync(join(outside, 'dir', 'kept.txt'), 'utf8')).toBe('kept')
})

test('a link in place of the root, the folder or the session is not gone through', () => {
  const { base, root, cwd } = place()
  // A folder elsewhere with one by the session's ID, as Claude Code's projects/ has.
  const outside = tmp.make('nod-outside-')
  const precious = join(outside, MINE, 'precious.txt')
  mkdirSync(join(outside, MINE))
  writeFileSync(precious, 'precious')

  mkdirSync(root)
  symlinkSync(outside, dirname(tempFolder(base, cwd, MINE)))
  expect(removeTmp(root, cwd, mine)).toBe(false)

  const second = place()
  mkdirSync(tempFolder(second.base, second.cwd, THEIRS), { recursive: true })
  symlinkSync(join(outside, MINE), tempFolder(second.base, second.cwd, MINE))
  expect(removeTmp(second.root, second.cwd, mine)).toBe(false)

  const third = place()
  const away = place()
  temp(away.base, third.cwd, MINE)
  symlinkSync(away.root, third.root)
  expect(removeTmp(third.root, third.cwd, mine)).toBe(false)
  expect(existsSync(tempFolder(away.base, third.cwd, MINE))).toBe(true)

  expect(readFileSync(precious, 'utf8')).toBe('precious')
})

test('a session folder it cannot remove says why, and does not keep the others', () => {
  // Whichever of the two it comes to first.
  for (const [first, second] of [
    [MINE, THEIRS],
    [THEIRS, MINE],
  ] as const) {
    const { base, root, cwd } = place()
    const locked = temp(base, cwd, first)
    const other = temp(base, cwd, second)
    chmodSync(join(locked, 'scratchpad'), 0o555)
    // Bun 1.3.14 says EACCES, 1.4.4 ENOTEMPTY.
    expect(() => removeTmp(root, cwd, () => true)).toThrow(/EACCES|ENOTEMPTY/)
    expect(existsSync(other)).toBe(false)
    // What is left of it is out of its session's way, and goes the next time.
    expect(existsSync(locked)).toBe(false)
    const [left = ''] = readdirSync(dirname(locked))
    expect(left).toStartWith(`${first}.gone-`)
    chmodSync(join(dirname(locked), left, 'scratchpad'), 0o755)
    expect(removeTmp(root, cwd, () => true)).toBe(true)
    expect(readdirSync(root)).toEqual([])
  }
})

test("what a session's worker, told to go on meanwhile, writes as its folder goes stays", () => {
  const { base, root, cwd } = place()
  const session = temp(base, cwd, MINE)
  const anew = join(session, 'scratchpad', 'new.txt')
  const rm = rmSync
  // As the removal starts: the worker's Claude Code makes its folder anew.
  const spy = spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    mkdirSync(dirname(anew), { recursive: true })
    writeFileSync(anew, 'new')
    rm(path, options)
  })
  try {
    expect(removeTmp(root, cwd, mine)).toBe(true)
  } finally {
    spy.mockRestore()
  }
  expect(readFileSync(anew, 'utf8')).toBe('new')
  expect(existsSync(join(session, 'scratchpad', 'a.txt'))).toBe(false)
  expect(readdirSync(dirname(session))).toEqual([MINE])
})

test('a session folder that stays is a failure, whatever stopped its removal', () => {
  const { base, root, cwd } = place()
  const session = temp(base, cwd, MINE)
  // As a process the worker left there, making files and removing them meanwhile, stops it.
  const spy = spyOn(fs, 'rmSync').mockImplementation(() => {
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
  })
  try {
    expect(() => removeTmp(root, cwd, mine)).toThrow('ENOENT')
  } finally {
    spy.mockRestore()
  }
  expect(existsSync(dirname(session))).toBe(true)
  expect(removeTmp(root, cwd, mine)).toBe(true)
  expect(readdirSync(root)).toEqual([])
})

test('a session folder another gc takes first is no failure', () => {
  const { base, root, cwd } = place()
  const taken = temp(base, cwd, MINE)
  // The other gc comes once this one has found the folder.
  const took = (id: string): boolean => {
    renameSync(taken, `${taken}.gone-${crypto.randomUUID()}`)
    return mine(id)
  }
  expect(removeTmp(root, cwd, took)).toBe(false)
  // One cut off before it was done leaves it so, for the next.
  expect(removeTmp(root, cwd, mine)).toBe(true)
  expect(readdirSync(root)).toEqual([])
})
