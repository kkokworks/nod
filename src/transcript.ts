import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { configDir, transcriptPath } from './account'
import type { Attempt, Ledger } from './ledger'
import { message } from './proc'
import { jsonOrNull } from './report'
import { pasted } from './tmux'

// Reading the transcript Claude Code keeps of a worker's session (JSONL): whether there is one, its
// lines or its end, how its last turn ended, whether a tool runs, what became of a message pasted in
// while a turn ran, which tool calls the person refused or auto mode denied, and whether a subagent
// runs in the background; and of any session, what the model wrote in its turn (textsThisTurn). It
// only reads: what nod changes in the ledger by it is turns.ts's
// (endTurnWithoutStop, forgetHeldBack, stoppedDialogs, refusedDialogs, unseenHeldBack), worker.ts's
// (carryUnheard, restingTurns) and allow.ts's (unjudged). This module imports none of worker.ts,
// hooks.ts or land.ts.

// How Claude Code marks a turn the person stopped (endTurnWithoutStop), how much of the
// transcript's end is read for it, and what a typed turn that ended without a Stop ends with in the
// ledger.
const STOP_MARK = '[Request interrupted by user'
const TRANSCRIPT_TAIL = 256 * 1024
export const STOPPED_TURN = 'the person stopped it (Escape)'
export const HELD_BACK = 'a hook held the message back'
// How long the hooks of a message may keep it on its way in (onItsWay): Claude Code's own limit for
// most of them.
const PROMPT_HOOKS_MS = 60_000

// The lines of the transcript of a task's session; null for one there is none of, or that cannot
// be read, which goes to stderr only.
export function transcriptLines(
  ledger: Ledger,
  home: string,
  taskId: number,
  sessionId: string,
): string[] | null {
  try {
    const file = transcriptOf(ledger, home, taskId, sessionId)
    return file === null ? null : readFileSync(file, 'utf8').split('\n')
  } catch (error) {
    console.error(`nod: could not read the transcript of task n${taskId}: ${message(error)}`)
    return null
  }
}

// The lines at the end (TRANSCRIPT_TAIL) of the transcript of turn `open`'s session; none for one
// there is none of, or that cannot be read, which goes to stderr only.
export function transcriptTail(ledger: Ledger, home: string, open: Attempt): string[] {
  try {
    const file = transcriptOf(ledger, home, open.taskId, open.sessionId)
    if (file === null) return []
    const fd = openSync(file, 'r')
    try {
      const size = fstatSync(fd).size
      const end = Buffer.alloc(Math.min(size, TRANSCRIPT_TAIL))
      readSync(fd, end, 0, end.length, size - end.length)
      return end.toString().split('\n')
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    console.error(`nod: could not read the transcript of task n${open.taskId}: ${message(error)}`)
    return []
  }
}

// How long the transcript of a task's session is, in bytes; 0 for one there is none of yet.
export function transcriptSize(
  ledger: Ledger,
  home: string,
  taskId: number,
  sessionId: string,
): number {
  const file = transcriptOf(ledger, home, taskId, sessionId)
  return file === null ? 0 : statSync(file).size
}

// The lines the transcript of a task's session got past `from` (transcriptSize); none for one there
// is none of, or that cannot be read, which goes to stderr only.
export function transcriptSince(
  ledger: Ledger,
  home: string,
  taskId: number,
  sessionId: string,
  from: number,
): string[] {
  try {
    const file = transcriptOf(ledger, home, taskId, sessionId)
    return file === null ? [] : readFileSync(file).subarray(from).toString().split('\n')
  } catch (error) {
    console.error(`nod: could not read the transcript of task n${taskId}: ${message(error)}`)
    return []
  }
}

// Where Claude Code keeps the transcript of the task's session `sessionId`: in the account its
// worker runs as, where '' is Claude Code's default folder and null an account nod never recorded.
export function transcriptOf(
  ledger: Ledger,
  home: string,
  taskId: number,
  sessionId: string,
): string | null {
  const { account } = ledger.get(taskId)
  return transcriptPath(account === null ? configDir(home) : account || null, sessionId)
}

// The transcripts of the subagents of the session whose transcript is the file `path`: in a folder
// beside it, and the folders in that (a workflow's).
export function subagentsOf(path: string): string[] {
  const beside = join(path.replace(/\.jsonl$/, ''), 'subagents')
  if (!existsSync(beside)) return []
  return readdirSync(beside, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(beside, f))
}

// Whether Claude Code keeps a transcript of session `sessionId` in the config dir `config`.
export function hasTranscript(config: string | null, sessionId: string): boolean {
  return transcriptPath(config, sessionId) !== null
}

const TranscriptEntry = z.object({
  type: z.string(),
  subtype: z.string().optional().catch(undefined),
  timestamp: z.string().optional().catch(undefined),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional().catch(undefined),
  // Who a user row's message is from: `human`, another session's (`peer`), a background task's
  // notice (2.1.332; none on older rows).
  origin: z.object({ kind: z.string() }).optional().catch(undefined),
  // Who started the turn, on the user row that starts it (2.1.278 to 2.1.332): `human`, `peer`,
  // `task_notification`, `scheduled`, `sdk`, `system`, `auto_continuation`.
  turnOrigin: z.string().optional().catch(undefined),
  queueTranscriptOnly: z.boolean().optional().catch(undefined),
  interruptedByShutdown: z.boolean().optional(),
  promptSubmitEnding: z.object({ promptKept: z.unknown() }).partial().optional().catch({}),
  message: z.object({ content: z.unknown() }).optional(),
  // Of Claude Code's queue (heardOf); an entry they do not fit still reads.
  operation: z.string().optional().catch(undefined),
  content: z.unknown().optional(),
  attachment: z.object({ type: z.string(), prompt: z.unknown() }).optional().catch(undefined),
})
type Row = z.infer<typeof TranscriptEntry>

// The rows of a transcript's end `lines` (transcriptTail) that say how its last turn stands, the last
// first: the person's, the worker's and Claude Code's own (system) in the main thread, not a
// subagent's (sidechain). Not the person's rows that are no turn: a meta row; one Claude Code keeps
// for the record only (`queueTranscriptOnly`: the notice that a background agent finished, whose
// report comes as a message of its own, which Claude Code leaves out too as it looks for a turn,
// 2.1.328); what a local command such as /exit leaves.
function* turnRows(lines: string[]): Generator<Row> {
  for (const line of lines.toReversed()) {
    const parsed = TranscriptEntry.safeParse(jsonOrNull(line))
    if (!parsed.success || parsed.data.isSidechain === true) continue
    const row = parsed.data
    if (row.type === 'user') {
      if (row.isMeta === true || row.queueTranscriptOnly === true || localCommand(row)) continue
    }
    if (['user', 'assistant', 'system'].includes(row.type)) yield row
  }
}

// How the last turn in a transcript's end `lines` (transcriptTail) ended, if without a Stop hook;
// null if it did not, or for all this can tell. Read as Claude Code reads its own transcript
// (2.1.310's binary): the last message of the person's or the worker's (turnRows) decides. The
// person's stop
// is their message `[Request interrupted by user…]`, in a text block, so a tool's output holding
// the words is none, and not one Claude Code marks as written as it shut down
// (`interruptedByShutdown`), a turn cut off. A message a hook held back leaves no message of the
// person's but a system entry with `promptSubmitEnding` (measured on 2.1.310 with `claude -p`). So
// does one held back while a turn runs, a background agent's report say, which goes on past it: right
// after a tool's result, where Claude Code gives a turn what waits for it (read from nod's own
// workers, 2.1.312 to 2.1.330), or after a message that started the turn along with it (2.1.330's
// binary). So one after a row of the person's is none of its end, but for their stop, or a row from
// before `since`, when that turn began: a turn cut off there. Nor counts what bash mode left, or the
// held-back message itself, which a hook that stops it (`continue: false`) keeps in the conversation
// with no turn (`promptKept`, 2.1.330's binary).
export function endedWithoutStop(lines: string[], since = 0): string | null {
  let held = false
  let kept = 0
  for (const row of turnRows(lines)) {
    if (row.type === 'system') {
      held ||= row.promptSubmitEnding !== undefined
      if (row.promptSubmitEnding?.promptKept === true) kept++
      continue
    }
    const stopped = row.type === 'user' && says(row, STOP_MARK)
    if (held) {
      if (row.type === 'user' && says(row, '<bash-')) continue
      if (row.type === 'user' && resultsOf(row).length === 0 && kept-- > 0) continue
      const before = Date.parse(row.timestamp ?? '') < since
      return row.type === 'user' && !stopped && !before ? null : HELD_BACK
    }
    if (row.type === 'assistant') return null
    return stopped && row.interruptedByShutdown !== true ? STOPPED_TURN : null
  }
  return held ? HELD_BACK : null
}

// Whether `lines` end with a message Claude Code queued, or took from its queue, with nothing written
// of what came of it: its prompt hooks run (2.1.314 to 2.1.330, about 100 ms). One from longer ago than
// they may take waits for something else, or went with its Claude Code.
export function onItsWay(lines: string[]): boolean {
  for (const line of lines.toReversed()) {
    const row = TranscriptEntry.safeParse(jsonOrNull(line)).data
    if (row?.type === 'queue-operation') {
      const age = Date.now() - Date.parse(row.timestamp ?? '')
      return ['enqueue', 'dequeue'].includes(row.operation ?? '') && age < PROMPT_HOOKS_MS
    }
    if (['user', 'assistant', 'system'].includes(row?.type ?? '')) return false
  }
  return false
}

// The last message a hook held back in `lines`: when, and what Claude Code shows of it, the hook's
// reason, then the message's words unless the hook hides them (2.1.328). NaN and '' once Claude Code
// keeps it otherwise.
export function lastHeldBack(lines: string[]): { at: number; shown: string } | null {
  for (const row of turnRows(lines)) {
    if (row.promptSubmitEnding === undefined) continue
    const shown = typeof row.content === 'string' ? row.content : ''
    return { at: Date.parse(row.timestamp ?? ''), shown }
  }
  return null
}

// Whether a tool call of the last turn in `lines` still has no result: it runs, or its dialog shows.
// A turn's first message or the last one's end (`turn_duration`) is as far back as it looks.
// ponytail: a call whose result went with the Claude Code that ran it reads as running until the next
// turn; one before what nod reads (results that long of calls run at once) reads as none.
export function toolRuns(lines: string[]): boolean {
  const done = new Set<unknown>()
  for (const row of turnRows(lines)) {
    if (row.type === 'system') {
      if (row.subtype === 'turn_duration') return false
      continue
    }
    if (row.type === 'user') {
      const results = resultsOf(row)
      if (results.length === 0) return false
      for (const id of results) done.add(id)
    } else if (blocksOf(row).some((b) => b?.type === 'tool_use' && !done.has(b.id))) return true
  }
  return false
}

// What became of a message pasted into a worker's Claude Code while a turn ran (heardOf).
type Fate = 'heard' | 'queued' | 'lost'

// What became of `text`, pasted into a worker's Claude Code while a turn ran, as the transcript
// `lines` show it (2.1.310, read from nod's own workers). Claude Code queues it (a
// `queue-operation` entry, `enqueue`, one of several lines wrapped in `<pasted_content>`), and
// takes it out of the queue (`remove`) as it gives it to the worker at the turn's next tool call,
// in an `attachment` entry of type `queued_command`, or (`dequeue`) as it runs it as a turn of its
// own once the turn ends. One that waited in the prompt file while Claude Code started again
// (deliver) is in the first message of that start, a `user` entry, with no queue. The last entry
// with the words decides, so words sent again count from their last. 'lost': no entry, so Claude
// Code never had it.
// ponytail: reads the whole transcript, parsing only the lines with the words; words Claude Code
// changed otherwise (spoken) read as lost and go twice.
export function heardOf(lines: string[], text: string): Fate {
  const sent = spoken(text)
  // Claude Code takes no blank message.
  if (sent === '') return 'heard'
  // Lines to parse: the longest piece no tab can have changed, as the line may hold either.
  const piece = sent.split(TAB_AS_PASTED).reduce((a, b) => (b.length > a.length ? b : a))
  const words = JSON.stringify(piece).slice(1, -1)
  let fate: Fate = 'lost'
  for (const line of lines) {
    if (!line.includes(words)) continue
    const parsed = TranscriptEntry.safeParse(jsonOrNull(line))
    if (!parsed.success || parsed.data.isSidechain === true || parsed.data.isMeta === true) continue
    const { type, operation, content, attachment, message } = parsed.data
    const said =
      type === 'queue-operation'
        ? [content]
        : type === 'user'
          ? textsOf(message?.content)
          : attachment?.type === 'queued_command'
            ? [attachment.prompt]
            : []
    const held = said.filter((s) => typeof s === 'string')
    if (!held.some((s) => holds(s, text))) continue
    fate = type === 'queue-operation' && operation === 'enqueue' ? 'queued' : 'heard'
  }
  return fate
}

// How a paste of several lines comes back: wrapped, in the transcript and in the prompt hook.
export const PASTE_WRAP = /<\/?pasted_content\b[^>]*>/g

// What Claude Code makes of a tab in a paste (2.1.319's binary). One message it started with, from
// its arguments, may keep its tabs, so both sides are read this way.
const TAB_AS_PASTED = '    '

// The words of a message as they show once Claude Code has it.
export const spoken = (text: string): string => pasted(text).trim().replaceAll('\t', TAB_AS_PASTED)

// Whether what Claude Code has of a message, `said`, is the message `text`: its words in whole lines,
// as a paste comes wrapped and a start's arguments hold it among others. The same words inside a
// longer sentence are another message, which a person may type with `text` still to go.
export const holds = (said: string, text: string): boolean =>
  `\n${spoken(said.replace(PASTE_WRAP, '\n'))}\n`.includes(`\n${spoken(text)}\n`)

// A short mark of a message, the same for what nod pastes and what the prompt hook gets of it.
export const promptMark = (prompt: string): string =>
  Bun.hash(spoken(prompt.replace(PASTE_WRAP, ''))).toString(36)

// What Claude Code gives the worker as a tool's result once the person refused it in its permission
// dialog, with or without words of theirs after it, and once they stopped it with Escape (2.1.316's
// binary: a turn's own dialog, not a subagent's, whose refusal says "Permission for this tool use
// was denied"; nor a rule's or a hook's, which say why).
const REFUSED = "The user doesn't want to proceed with this tool use."

// A tool call of the worker's, not a subagent's (sidechain), in a transcript's end `lines`
// (transcriptTail), oldest first, and whether the person refused it (REFUSED).
export type ToolCall = { name: string; input: Record<string, unknown>; refused: boolean }

const ToolUse = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})
const ToolResult = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.unknown(),
})

// The worker's tool calls in `lines`, and which the person refused, as Claude Code keeps them: a
// `tool_use` block of an assistant message, and its `tool_result` in a user message after it.
// ponytail: matched by Claude Code's own words, undocumented; words it changes read as no refusal.
export function toolCalls(lines: string[]): ToolCall[] {
  const calls = new Map<string, ToolCall>()
  for (const line of lines) {
    const parsed = TranscriptEntry.safeParse(jsonOrNull(line))
    if (!parsed.success || parsed.data.isSidechain === true) continue
    const { type, message } = parsed.data
    const blocks = Array.isArray(message?.content) ? message.content : []
    for (const block of blocks) {
      const use = type === 'assistant' ? ToolUse.safeParse(block) : null
      if (use?.success) {
        const { id, name, input } = use.data
        calls.set(id, { name, input, refused: false })
      }
      const result = type === 'user' ? ToolResult.safeParse(block) : null
      const call = result?.success ? calls.get(result.data.tool_use_id) : undefined
      if (result?.success && call !== undefined && result.data.is_error === true) {
        call.refused = textsOf(result.data.content).some(
          (t) => typeof t === 'string' && t.startsWith(REFUSED),
        )
      }
    }
  }
  return [...calls.values()]
}

// How Claude Code words, and marks, a tool's result that auto mode's check denied as unsafe (2.1.331's
// binary; on all 13 such results of nod's workers' last two weeks, 2.1.321 to 2.1.331). One the check
// gave no verdict on has other words, and `classifier:auto-mode:unavailable`.
const DENIED =
  /^Permission for this action (was denied by the Claude Code auto mode classifier|has been denied)\b/
const MAY_BE_DENIED = /Permission for this action|"classifier:auto-mode"/
const Denied = z.object({
  permissionDecision: z.object({
    decision: z.literal('reject'),
    reasonCode: z.literal('classifier:auto-mode'),
  }),
})

// Whether auto mode's check denied a call as unsafe in the session whose transcript is the file
// `path`, or in a subagent of it, ever: what the check counts toward asking the person goes on past a
// turn. Throws when the transcript, or that of the subagent `agentId`, cannot be read.
// ponytail: a call denied beside the one asked about, in the same response, may not be in it yet.
export function autoModeDenied(path: string, agentId: string | undefined): boolean {
  const agents = subagentsOf(path)
  if (agentId !== undefined && !agents.some((f) => basename(f) === `agent-${agentId}.jsonl`)) {
    throw new Error(`no transcript of subagent ${agentId}`)
  }
  return [path, ...agents].some((file) => {
    const text = readFileSync(file, 'utf8')
    return MAY_BE_DENIED.test(text) && text.split('\n').some(denies)
  })
}

const SubagentMeta = z.object({ requestShape: z.string() })

// Whether the subagent `agentId` of the session whose transcript is the file `path` was started to run
// in the background, as Claude Code keeps it beside that subagent's transcript (2.1.326 to 2.1.332; of
// all 13 whose dialogs became decisions, read from nod's own workers). False for all this can tell.
export function inBackground(path: string, agentId: string): boolean {
  const transcript = subagentsOf(path).find((f) => basename(f) === `agent-${agentId}.jsonl`)
  const meta = transcript?.replace(/\.jsonl$/, '.meta.json')
  if (meta === undefined || !existsSync(meta)) return false
  const parsed = SubagentMeta.safeParse(jsonOrNull(readFileSync(meta, 'utf8')))
  return parsed.data?.requestShape === 'background'
}

// A line that may be one, and does not read, counts as one.
function denies(line: string): boolean {
  if (!MAY_BE_DENIED.test(line)) return false
  const json = jsonOrNull(line)
  const row = TranscriptEntry.safeParse(json)
  if (!row.success || Denied.safeParse(json).success) return true
  return blocksOf(row.data).some((block) => {
    const result = ToolResult.safeParse(block)
    return (
      result.success &&
      result.data.is_error === true &&
      textsOf(result.data.content).some((t) => typeof t === 'string' && DENIED.test(t))
    )
  })
}

// What the model wrote before its tool call `call` (its id) in its turn, as the transcript `lines`
// keep it: the text blocks of the main thread's messages after the row that started the turn,
// oldest first. That row is the one Claude Code marks as a turn's start (`turnOrigin`), whoever's
// message it is: the person's, another session's, a background task's notice, a scheduled run's, or
// a compacted summary that carries the turn on into a new file. What comes in while a turn runs (a
// queued message, a record-only notice) has no `turnOrigin` (2.1.278 to 2.1.332, read from every
// such row of this machine's transcripts by its parentUuid), so it does not end the turn.
// But a turn that a message not the person's started right after the previous one ended
// (QUEUED_TURN_MS) goes on from it, as the person had no time to read what that one wrote.
// A transcript with no `turnOrigin` (an older Claude Code's) has the turn start at the person's last
// message instead (personSaid).
// Null when the call is not in `lines`, or no turn's start is before it.
export function textsThisTurn(lines: string[], call: string): string[] | null {
  const marked = lines.some((line) => line.includes('"turnOrigin":'))
  const rowAt = (i: number): Row | null => {
    const parsed = TranscriptEntry.safeParse(jsonOrNull(lines[i] ?? ''))
    return parsed.success && parsed.data.isSidechain !== true ? parsed.data : null
  }
  // Whether the turn row `i` starts goes on from the one before: started by no message of the
  // person's within QUEUED_TURN_MS of that one's end (its turn_duration row). One that ended with no
  // such row (stopped, an API error) does not.
  const goesOn = (i: number, start: Row): boolean => {
    if (start.turnOrigin === 'human') return false
    for (let j = i - 1; j >= 0; j--) {
      const row = rowAt(j)
      if (row?.type === 'system' && row.subtype === 'turn_duration') {
        const gap = Date.parse(start.timestamp ?? '') - Date.parse(row.timestamp ?? '')
        return gap <= QUEUED_TURN_MS
      }
      if (row?.type === 'user' && row.turnOrigin !== undefined) return false
    }
    return false
  }
  const texts: string[] = []
  let found = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = rowAt(i)
    if (row === null) continue
    if (row.type === 'assistant') {
      found ||= blocksOf(row).some((b) => b?.type === 'tool_use' && b.id === call)
      const said = textsOf(row.message?.content).filter((t) => typeof t === 'string')
      if (found) texts.unshift(...said)
    }
    if (!found) continue
    if (
      marked
        ? row.type === 'user' && row.turnOrigin !== undefined && !goesOn(i, row)
        : personSaid(row)
    )
      return texts
  }
  return null
}

// How soon after a turn's end a turn that a message not the person's started counts as that turn
// going on (textsThisTurn). In the case the ask hook was made for (2.1.332), a turn that another
// session's message started wrote a draft and ended; 0.19 s later the next such message started a
// turn that opened the dialog, 18 s on, with no words of its own. Claude Code's queue does not tell
// such a message apart: it was enqueued after that turn's end (turn_duration at .084 s, enqueue at
// .270 s), not while the turn ran. Of the AskUserQuestion calls in the transcripts it was measured
// on (201), 2 s brought that one back and none of those denied before for an earlier turn's draft
// the person had seen.
export const QUEUED_TURN_MS = 2000

// Whether a row of a transcript with no `turnOrigin` is a message of the person's. Not a tool's
// result, a meta row (a reminder, another session's message), a compacted conversation's summary, a
// row kept for the record only (`queueTranscriptOnly`), or a row of any `origin` but `human`. Nor a
// local command's, which leaves no `origin` and runs while a turn does; one with `origin: human` is
// a command such as a skill's, which starts a turn.
// ponytail: a row with no `origin`, a background task's notice say, counts as the person's, so the
// turn reads shorter; a skill's command with none reads as no message of theirs.
const personSaid = (row: Row): boolean =>
  row.type === 'user' &&
  row.isMeta !== true &&
  row.isCompactSummary !== true &&
  row.queueTranscriptOnly !== true &&
  (row.origin === undefined ? !localCommand(row) : row.origin.kind === 'human') &&
  resultsOf(row).length === 0

// What a local command such as /exit leaves in the transcript, the command and its output.
const localCommand = (row: Row): boolean =>
  textsOf(row.message?.content).some(
    (t) => typeof t === 'string' && /^<(command-|local-command-)/.test(t),
  )

// The blocks of a transcript row's message, and the tool calls whose results it holds, by their ids.
const blocksOf = (row: Row) => (Array.isArray(row.message?.content) ? row.message.content : [])
const resultsOf = (row: Row): unknown[] =>
  blocksOf(row).flatMap((b) => (b?.type === 'tool_result' ? [b.tool_use_id] : []))

// Whether a text of a transcript row's message starts with `mark`.
const says = (row: Row, mark: string): boolean =>
  textsOf(row.message?.content).some((t) => typeof t === 'string' && t.startsWith(mark))

// The text of a transcript message's `content`: a string, or the text blocks of a list.
const textsOf = (content: unknown): unknown[] =>
  Array.isArray(content)
    ? content.flatMap((b) => (b?.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    : [content]
