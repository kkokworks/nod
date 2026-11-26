import { afterAll, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { HIDES_DRAFT, onAsk } from './hooks'
import { openSettings, workerSettings } from './settings'

const tmp = tempDirs()
afterAll(tmp.removeAll)
const cli = resolve(import.meta.dir, 'cli.ts')

// Transcript rows as Claude Code 2.1.332 writes them, one block to a row.
const row = (r: object): string => JSON.stringify(r)
const person = (text: string) =>
  row({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } })
const wrote = (text: string) =>
  row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const called = (id: string, name = 'AskUserQuestion') =>
  row({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
  })
const result = (id: string) =>
  row({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  })
const DRAFT = '> Hi all, the release moves to Friday.\n> Questions to me.'
const CODE = 'The message:\n\n```\nHi all, the release moves to Friday.\n```'

// The hook's input, its question's options with these previews.
const asked = (previews: (string | undefined)[] = [undefined, undefined], id = 'toolu_ask') => ({
  transcript_path: '/transcript.jsonl',
  tool_use_id: id,
  tool_input: {
    questions: [
      {
        question: 'Post this?',
        header: 'Post',
        multiSelect: false,
        options: previews.map((preview, i) => ({
          label: `option ${i}`,
          description: 'd',
          ...(preview === undefined ? {} : { preview }),
        })),
      },
    ],
  },
})
const judge = (lines: string[], event = asked()) =>
  onAsk(
    event,
    () => lines.join('\n'),
    async () => {},
  )

test('a question dialog with no preview, in a turn that wrote a draft, is denied; with a preview, or with no draft, it gets no answer', async () => {
  const turn = (text: string) => [
    person('write the release note'),
    wrote(text),
    called('toolu_ask'),
  ]
  expect(await judge(turn(DRAFT))).toEqual(HIDES_DRAFT)
  expect(await judge(turn(CODE))).toEqual(HIDES_DRAFT)
  // An indented quote, as in a list.
  expect(await judge(turn('Draft:\n  > Hi all.'))).toEqual(HIDES_DRAFT)
  // A preview on any option of any question shows the draft; a blank one shows nothing.
  expect(await judge(turn(DRAFT), asked([undefined, DRAFT]))).toBeNull()
  expect(await judge(turn(DRAFT), asked([' \n', '']))).toEqual(HIDES_DRAFT)
  // No draft: a plain question, inline code, a `>` inside a line.
  expect(await judge(turn('Which branch should the fix go on, `main` or `next`? a > b'))).toBeNull()
  expect(await judge([person('hi'), called('toolu_ask')])).toBeNull()
  // The deny is all the hook answers: never an allow.
  expect(HIDES_DRAFT.hookSpecificOutput.permissionDecision).toBe('deny')
})

test("the turn is what came after the person's last message: tool results, Claude Code's own messages and other sessions' do not end it, and an earlier turn's draft does not count", async () => {
  const earlier = [person('draft it'), wrote(DRAFT), person('now the other thing')]
  expect(await judge([...earlier, wrote('Which one?'), called('toolu_ask')])).toBeNull()
  // Drafted in this turn, before a tool ran, a reminder, another session's message, a background
  // task's notice, a compacted summary, attachments and system rows: still this turn's.
  const between = [
    called('toolu_read', 'Read'),
    result('toolu_read'),
    row({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<system-reminder>x</system-reminder>' },
    }),
    row({
      type: 'user',
      isMeta: true,
      origin: { kind: 'peer', from: 'n' },
      message: { role: 'user', content: 'task n1 succeeded' },
    }),
    row({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification>done</task-notification>' },
    }),
    row({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary' } }),
    row({ type: 'attachment', attachment: { type: 'hook_success' } }),
    row({ type: 'system', subtype: 'turn_duration' }),
  ]
  expect(await judge([...earlier, wrote(DRAFT), ...between, called('toolu_ask')])).toEqual(
    HIDES_DRAFT,
  )
  // A row of an older Claude Code, with no origin, is the person's.
  const older = row({ type: 'user', message: { role: 'user', content: 'go on' } })
  expect(await judge([person('draft it'), wrote(DRAFT), older, called('toolu_ask')])).toBeNull()
  // A subagent's draft is not the main thread's.
  const sub = row({
    type: 'assistant',
    isSidechain: true,
    message: { content: [{ type: 'text', text: DRAFT }] },
  })
  expect(await judge([person('go'), sub, called('toolu_ask')])).toBeNull()
})

test('a transcript the hook cannot read, or does not know, gets no answer; one the call is written to on a later read is judged then', async () => {
  const turn = [person('draft it'), wrote(DRAFT), called('toolu_ask')]
  // One it cannot read throws, which nod hook ask takes as no answer (below).
  await expect(
    onAsk(asked(), () => {
      throw new Error('ENOENT')
    }),
  ).rejects.toThrow('ENOENT')
  // No message of the person's before the call, or rows that are not JSON.
  expect(await judge([wrote(DRAFT), called('toolu_ask')])).toBeNull()
  expect(await judge(['not json', DRAFT, '{"type":'])).toBeNull()
  // The call not written: it reads again, waiting between, and then gives up.
  let reads = 0
  const waits: number[] = []
  const never = await onAsk(
    asked(),
    () => {
      reads++
      return turn.slice(0, 2).join('\n')
    },
    async () => waits.push(reads),
  )
  expect(never).toBeNull()
  expect(reads).toBe(21)
  expect(waits).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  // Written by its second read: the draft before it counts.
  const shown = [turn.slice(0, 2).join('\n'), turn.join('\n')]
  reads = 0
  expect(
    await onAsk(
      asked(),
      () => shown[Math.min(reads++, 1)] ?? '',
      async () => {},
    ),
  ).toEqual(HIDES_DRAFT)
  expect(reads).toBe(2)
})

test('nod hook ask prints the deny for a hidden draft and nothing else, exiting 0 whatever goes wrong', async () => {
  const dir = tmp.make('nod-ask-')
  const transcript = join(dir, 'session.jsonl')
  writeFileSync(
    transcript,
    `${[person('draft it'), wrote(DRAFT), called('toolu_ask')].join('\n')}\n`,
  )
  const run = async (stdin: string) => {
    const proc = Bun.spawn(['bun', cli, 'hook', 'ask'], {
      env: { ...process.env, NOD_HOME: tmp.make('nod-ask-home-') },
      stdin: new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(0)
    return new Response(proc.stdout).text()
  }
  const event = (path: string, previews?: (string | undefined)[]) =>
    JSON.stringify({
      ...asked(previews),
      transcript_path: path,
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
    })
  expect(JSON.parse(await run(event(transcript)))).toEqual(HIDES_DRAFT)
  expect(await run(event(transcript, ['a draft', undefined]))).toBe('')
  expect(await run(event(join(dir, 'gone.jsonl')))).toBe('')
  expect(await run('{"tool_input": 3}')).toBe('')
  // Four runs of nod, each starting Bun, on a machine busy with other work.
}, 15_000)

test("nod open's sessions get the hook on AskUserQuestion, but a relay's and a worker's do not", () => {
  const preToolUse = (settings: string) => JSON.parse(settings).hooks.PreToolUse
  expect(preToolUse(openSettings())).toEqual([
    {
      matcher: 'AskUserQuestion',
      hooks: [{ type: 'command', command: expect.stringMatching(/ hook ask$/) }],
    },
  ])
  expect(preToolUse(openSettings(true))).toBeUndefined()
  expect(JSON.parse(openSettings(true)).hooks.SessionStart).toEqual(
    JSON.parse(openSettings()).hooks.SessionStart,
  )
  expect(workerSettings(null, '/sockets', [])).not.toContain('AskUserQuestion')
})
