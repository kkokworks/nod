import { afterAll, expect, test } from 'bun:test'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { HIDES_DRAFT, onAsk, readGrown } from './hooks'
import { openSettings, workerSettings } from './settings'
import { QUEUED_TURN_MS } from './transcript'

const tmp = tempDirs()
afterAll(tmp.removeAll)
const cli = resolve(import.meta.dir, 'cli.ts')

// Transcript rows as Claude Code 2.1.332 writes them, one block to a row; the row that starts a
// turn says who started it (turnOrigin).
const row = (r: object): string => JSON.stringify(r)
const person = (text: string) =>
  row({
    type: 'user',
    origin: { kind: 'human' },
    turnOrigin: 'human',
    message: { role: 'user', content: text },
  })
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
const judge = (lines: string[], event: Parameters<typeof onAsk>[0] = asked()) =>
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
  // A multi-select question shows no preview, and a question with no options (a typed answer) none
  // either: neither shows the draft, beside a single-select one with a preview or alone.
  const mixed = (multiSelect: boolean, previews: (string | undefined)[]) => {
    const event = asked(previews)
    const [question] = event.tool_input.questions
    if (question === undefined) throw new Error('no question')
    return {
      ...event,
      tool_input: {
        questions: [
          { ...question, multiSelect },
          { question: 'Why?', multiSelect: false },
        ],
      },
    }
  }
  expect(await judge(turn(DRAFT), mixed(true, [DRAFT, DRAFT]))).toEqual(HIDES_DRAFT)
  expect(await judge(turn(DRAFT), mixed(false, [DRAFT, undefined]))).toBeNull()
  expect(await judge(turn(DRAFT), mixed(false, [undefined]))).toEqual(HIDES_DRAFT)
  // No draft: a plain question, inline code, a `>` inside a line.
  expect(await judge(turn('Which branch should the fix go on, `main` or `next`? a > b'))).toBeNull()
  expect(await judge([person('hi'), called('toolu_ask')])).toBeNull()
  // The deny is all the hook answers: never an allow.
  expect(HIDES_DRAFT.hookSpecificOutput.permissionDecision).toBe('deny')
})

// What comes in while a turn runs, and rows of Claude Code's own: a tool's call and result, a
// reminder, another session's message and a background task's notice that came during the turn (no
// turnOrigin), a compacted summary, a record-only notice, a local command the person ran meanwhile
// and its output, an attachment, a system row.
const during = () =>
  [
    called('toolu_read', 'Read'),
    result('toolu_read'),
    { isMeta: true, content: '<system-reminder>x</system-reminder>' },
    { isMeta: true, origin: { kind: 'peer', from: 'n' }, content: 'task n1 succeeded' },
    {
      origin: { kind: 'task-notification' },
      content: '<task-notification>done</task-notification>',
    },
    { isCompactSummary: true, content: 'summary' },
    { queueTranscriptOnly: true, content: 'a background agent finished' },
    { content: '<command-name>/cost</command-name>' },
    { content: '<local-command-stdout>$0.12</local-command-stdout>' },
    row({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'task n2 failed' } }),
    row({ type: 'system', subtype: 'turn_duration' }),
  ].map((r) =>
    typeof r === 'string'
      ? r
      : row({ type: 'user', ...r, message: { role: 'user', content: r.content } }),
  )

test('the turn is what came after the row Claude Code marks as its start, whoever started it; what comes in during the turn does not end it, and an earlier turn does not count', async () => {
  // The person asked for a draft, and saw it as that turn ended.
  const earlier = [person('draft it'), wrote(DRAFT), wrote('Shall I post it?')]
  const peer = row({
    type: 'user',
    isMeta: true,
    origin: { kind: 'peer', from: 'n' },
    turnOrigin: 'peer',
    message: { role: 'user', content: 'task n1 succeeded' },
  })
  // A turn another session's message started, with no draft: the earlier one does not count.
  expect(await judge([...earlier, peer, wrote('Which branch?'), called('toolu_ask')])).toBeNull()
  // One with a draft of its own is denied.
  expect(await judge([...earlier, peer, wrote(DRAFT), called('toolu_ask')])).toEqual(HIDES_DRAFT)
  // So for each start: the person's, a background task's notice, a scheduled run, another
  // session's message with no origin, a compacted summary carrying the turn into a new file.
  const starts = [
    person('now the other thing'),
    row({
      type: 'user',
      origin: { kind: 'task-notification' },
      turnOrigin: 'task_notification',
      message: { role: 'user', content: '<task-notification>done</task-notification>' },
    }),
    row({ type: 'user', isMeta: true, turnOrigin: 'scheduled', message: { content: 'check' } }),
    row({ type: 'user', turnOrigin: 'peer', message: { role: 'user', content: 'n1' } }),
    row({ type: 'user', isCompactSummary: true, turnOrigin: 'human', message: { content: 's' } }),
  ]
  for (const start of starts) {
    expect(await judge([...earlier, start, wrote('Which one?'), called('toolu_ask')])).toBeNull()
    expect(await judge([...earlier, start, wrote(CODE), called('toolu_ask')])).toEqual(HIDES_DRAFT)
  }
  // Drafted in this turn before what came in during it: still this turn's.
  expect(await judge([person('draft it'), wrote(DRAFT), ...during(), called('toolu_ask')])).toEqual(
    HIDES_DRAFT,
  )
  expect(await judge([...earlier, peer, wrote(DRAFT), ...during(), called('toolu_ask')])).toEqual(
    HIDES_DRAFT,
  )
  // A subagent's draft is not the main thread's.
  const sub = row({
    type: 'assistant',
    isSidechain: true,
    message: { content: [{ type: 'text', text: DRAFT }] },
  })
  expect(await judge([person('go'), sub, called('toolu_ask')])).toBeNull()
})

test("a turn that a message not the person's started right after the previous one ended goes on from it: the person had no time to read the draft", async () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 26, 1, 57, 56) + ms).toISOString()
  const started = (turnOrigin: string, ms: number) =>
    row({
      type: 'user',
      isMeta: turnOrigin !== 'human',
      turnOrigin,
      timestamp: at(ms),
      message: { role: 'user', content: 'task n1 succeeded' },
    })
  const ended = (ms: number) => row({ type: 'system', subtype: 'turn_duration', timestamp: at(ms) })
  // A turn another session's message started writes a draft and ends at 0 ms.
  const drafted = [person('watch the release'), started('peer', -80_000), wrote(DRAFT), ended(0)]
  const next = (start: string) => [...drafted, start, called('toolu_ask')]
  // The next message starts a turn 0.19 s later, which asks with no words of its own: denied, as in
  // the case this was made for. Up to QUEUED_TURN_MS it is the same, and through several such turns.
  expect(await judge(next(started('peer', 190)))).toEqual(HIDES_DRAFT)
  expect(await judge(next(started('task_notification', QUEUED_TURN_MS)))).toEqual(HIDES_DRAFT)
  const twice = [...drafted, started('peer', 190), ended(5_000), started('peer', 6_000)]
  expect(await judge([...twice, called('toolu_ask')])).toEqual(HIDES_DRAFT)
  // Later than that, the person had time to read it, and a turn the person started is theirs.
  expect(await judge(next(started('peer', QUEUED_TURN_MS + 1)))).toBeNull()
  expect(await judge(next(started('human', 190)))).toBeNull()
  // A turn that ended with no turn_duration (stopped) does not go on, nor one with no times.
  const stopped = [person('watch'), started('peer', -80_000), wrote(DRAFT), started('peer', 190)]
  expect(await judge([...stopped, called('toolu_ask')])).toBeNull()
  const untimed = row({
    type: 'user',
    isMeta: true,
    turnOrigin: 'peer',
    message: { content: 'n1' },
  })
  expect(await judge([...drafted, untimed, called('toolu_ask')])).toBeNull()
})

test("a transcript with no turnOrigin (an older Claude Code's) has the turn start at the person's last message", async () => {
  const said = (text: string) => row({ type: 'user', message: { role: 'user', content: text } })
  const theirs = (text: string) =>
    row({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } })
  // An earlier turn's draft does not count, with origin or without.
  for (const start of [said, theirs]) {
    const earlier = [start('draft it'), wrote(DRAFT), start('now the other thing')]
    expect(await judge([...earlier, wrote('Which one?'), called('toolu_ask')])).toBeNull()
  }
  // What came in during the turn, and Claude Code's own rows, are not the person's.
  expect(await judge([said('draft it'), wrote(DRAFT), ...during(), called('toolu_ask')])).toEqual(
    HIDES_DRAFT,
  )
  // A command of theirs that starts a turn (a skill's) is theirs.
  const skill = theirs('<command-message>nod</command-message>\n<command-name>/nod</command-name>')
  expect(await judge([said('draft it'), wrote(DRAFT), skill, called('toolu_ask')])).toBeNull()
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

test('the hook reads the transcript again only once it has grown', () => {
  const file = join(tmp.make('nod-ask-grown-'), 'session.jsonl')
  writeFileSync(file, 'one\n')
  const read = readGrown()
  expect(read(file)).toBe('one\n')
  // Written over with as many bytes: what it read last.
  writeFileSync(file, 'two\n')
  expect(read(file)).toBe('one\n')
  appendFileSync(file, 'three\n')
  expect(read(file)).toBe('two\nthree\n')
  // Another reader reads it afresh; one that is gone throws.
  expect(readGrown()(file)).toBe('two\nthree\n')
  expect(() => read(join(file, 'gone'))).toThrow()
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
