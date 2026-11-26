import { afterAll, expect, test } from 'bun:test'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { marking, workerSubmodules } from '../test/git-commands'
import { bunTest, NOISY_FAILURE } from '../test/noisy-failure'
import { git } from '../test/remote'
import { tempDirs } from '../test/tmp'
import { sharedGitDenies } from './branch'
import { Ledger, type Task } from './ledger'
import { OUTPUT_LIMIT } from './proc'
import { reviewSettings, SANDBOX, verify } from './verify'

const tmp = tempDirs()
afterAll(tmp.removeAll)
const ledger = new Ledger(tmp.make('nod-verify-home-'))

// A task in `dir` with no repo: once its check fails, verify checks nothing more.
function taskIn(dir: string): Task {
  const id = ledger.add({
    brief: 'check it',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  ledger.setRunning(id, dir)
  return ledger.get(id)
}

const said = (cmd: string): string => `The acceptance check \`${cmd}\` failed:\n`

// A folder with `files`, for a check to run in.
function folderOf(files: Record<string, string>): string {
  const dir = tmp.make('nod-verify-')
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  return dir
}

test("what bun's test runner said failed stays in a failed check's output, past the warnings that fill its end", async () => {
  const dir = folderOf(NOISY_FAILURE.files)
  const check = await verify(ledger, taskIn(dir), 'NOD: done | did it', NOISY_FAILURE.check)
  expect(check?.passed).toBe(false)
  const output = check?.output ?? ''
  expect(output).toContain("\nerror: Cannot find module './gone'")
  expect(output).toContain("\nSyntaxError: Export named 'gone' not found in module")
  // Each failed test, with what failed it.
  expect(output).toMatch(
    /\nerror: expect\(received\)\.toBe\(expected\)\n\(fail\) the one that fails \[[\d.]+ms\]\n/,
  )
  expect(output).toMatch(/\nTypeError: the cause of it\n\(fail\) the one that throws \[/)
  expect(output).toMatch(
    /\n\(fail\) the one that times out \[[\d.]+ms\]\n {2}\^ this test timed out after 1ms\.\n/,
  )
  // Not the Error a passing test logged, which reads as one bun's test runner says failed.
  expect(output).not.toContain('caught and logged')
  // Its end as before, and no longer than it was.
  expect(output).toContain('Warning: a noisy render 300\n')
  expect(output).toContain('Ran 5 tests across 1 file.')
  expect(output).toHaveLength(said(NOISY_FAILURE.check).length + OUTPUT_LIMIT)
})

test("what bun's test runner said failed stays there in color too, and the output comes without it", async () => {
  const dir = folderOf(NOISY_FAILURE.files)
  const cmd = `FORCE_COLOR=1 ${JSON.stringify(process.execPath)} test ./noisy.test.ts`
  const output = (await verify(ledger, taskIn(dir), 'NOD: done | did it', cmd))?.output ?? ''
  expect(output).toMatch(/\nTypeError: the cause of it\n✗ the one that throws \[/)
  expect(output).not.toContain('caught and logged')
  expect(output).not.toContain('\u001b')
  expect(output).toHaveLength(said(cmd).length + OUTPUT_LIMIT)
})

test("bun's test runner repeats a failure at the end only with no agent around, and what failed it stays either way", async () => {
  const dir = folderOf({
    'repeats.test.ts': `import { test } from 'bun:test'
for (let i = 1; i <= 21; i++) test(\`passing \${i}\`, () => {})
test('the one that throws', () => {
  throw new Error('the cause of it')
})
test('a noisy one', () => {
  for (let i = 1; i <= 300; i++) console.error(\`Warning: a noisy render \${i}\`)
})
`,
  })
  // AGENT decides over CLAUDECODE, so this holds whatever runs these tests.
  const run = async (agent: string): Promise<string> => {
    const cmd = `export AGENT=${agent}; ${bunTest('./repeats.test.ts')}`
    const output = (await verify(ledger, taskIn(dir), 'NOD: done | did it', cmd))?.output ?? ''
    expect(output).toHaveLength(said(cmd).length + OUTPUT_LIMIT)
    return output
  }
  const cause = /\nerror: the cause of it\n\(fail\) the one that throws \[/
  const inAgent = await run('1')
  expect(inAgent).toMatch(cause)
  expect(inAgent).not.toContain('tests failed:')
  const alone = await run('0')
  expect(alone).toMatch(cause)
  expect(alone).toMatch(
    /\n1 tests failed:\n\(fail\) the one that throws \[[\d.]+ms\]\n\n 22 pass\n/,
  )
})

test("however many failures bun's test runner reports, the output keeps to its limit and its end", async () => {
  const dir = folderOf({
    'many.test.ts': `import { expect, test } from 'bun:test'
for (let i = 1; i <= 300; i++) test(\`failure number \${i} of many\`, () => expect(i).toBe(0))
`,
  })
  const cmd = bunTest('./many.test.ts')
  const output = (await verify(ledger, taskIn(dir), 'NOD: done | did it', cmd))?.output ?? ''
  expect(output).toContain('\n(fail) failure number 1 of many')
  expect(output).toContain(' 300 fail\n')
  expect(output).toHaveLength(said(cmd).length + OUTPUT_LIMIT)
})

test("bun's test runner's output whose end shows its failure keeps the end alone", async () => {
  const dir = folderOf({
    'late.test.ts': `import { expect, test } from 'bun:test'
test('a noisy one', () => {
  for (let i = 1; i <= 300; i++) console.error(\`Warning: a noisy render \${i}\`)
})
test('the one that fails last', () => {
  expect(1).toBe(2)
})
`,
  })
  const cmd = bunTest('./late.test.ts')
  const check = await verify(ledger, taskIn(dir), 'NOD: done | did it', cmd)
  const output = check?.output ?? ''
  expect(output).toMatch(/\n\(fail\) the one that fails last \[[\d.]+ms\]\n/)
  expect(output).not.toContain('bun test reported these failures')
  expect(output).toHaveLength(said(cmd).length + OUTPUT_LIMIT)
})

test("a check that is not bun's test runner keeps the end of its output alone, whatever lines it has", async () => {
  const cmd = `echo '(fail) the one that fails' >&2; echo 'error: it failed' >&2; seq 300 | sed 's/^/Warning: a noisy render /' >&2; exit 1`
  const check = await verify(ledger, taskIn(tmp.make('nod-verify-')), 'NOD: done | did it', cmd)
  const lines = Array.from({ length: 300 }, (_, i) => `Warning: a noisy render ${i + 1}\n`)
  const all = `(fail) the one that fails\nerror: it failed\n${lines.join('')}`
  expect(check).toEqual({ passed: false, output: said(cmd) + all.slice(-OUTPUT_LIMIT) })
})

test('verify runs none of the commands named in the config of a submodule its worker made', async () => {
  const dir = tmp.make('nod-verify-repo-')
  const { command, ran } = marking(tmp.make('nod-verify-marks-'))
  git(dir, 'init', '-q')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  workerSubmodules(dir, command)
  const id = ledger.add({
    brief: 'check it',
    repo: dir,
    branch: 'main',
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  ledger.setRunning(id, dir)

  await expect(verify(ledger, ledger.get(id), 'NOD: done | did it')).rejects.toThrow(
    'git status failed',
  )
  expect(ran()).toEqual([])
}, 30_000)

// The reviewer runs commands in the task's worktree after reading what the worker wrote there.
test("the independent reviewer's sandbox keeps it out of the shared git folder as its worker's does", () => {
  const repo = tmp.make('nod-verify-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  const id = ledger.add({
    brief: 'review it',
    repo,
    branch: 'fix/it',
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const { sandbox } = JSON.parse(reviewSettings(ledger.get(id)))
  expect(sandbox.filesystem.denyWrite).toEqual(sharedGitDenies(repo, 'fix/it'))
  const common = realpathSync(join(repo, '.git'))
  expect(sandbox.filesystem.denyWrite).toEqual(
    expect.arrayContaining(
      ['HEAD', 'index', 'packed-refs', 'refs/heads/main'].map((p) => join(common, p)),
    ),
  )
  expect(sandbox).toMatchObject(SANDBOX)
  const none = JSON.parse(reviewSettings(taskIn(tmp.make('nod-verify-'))))
  expect(none.sandbox.filesystem.denyWrite).toEqual([])
})
