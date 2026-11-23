import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { z } from 'zod'
import { configDir, transcriptPath } from './account'
import type { Attempt, Ledger } from './ledger'
import { message } from './proc'
import { jsonOrNull } from './report'
import { pasted } from './tmux'

// Reading the transcript Claude Code keeps of a worker's session (JSONL): whether there is one, its
// lines or its end, how its last turn ended, whether a tool runs, what became of a message pasted in
// while a turn ran, and which tool calls the person refused. It only reads: what nod changes in the
// ledger by it is turns.ts's (endTurnWithoutStop, forgetHeldBack, stoppedDialogs, refusedDialogs,
// unseenHeldBack) and worker.ts's (carryUnheard, restingTurns). This module imports none of
// worker.ts, hooks.ts or land.ts.

// How Claude Code marks a turn the person stopped (endTurnWithoutStop), how much of the
// transcript's end is read for it, and what a typed turn that ended without a Stop ends with in the
// ledger.
const STOP_MARK = '[Request interrupted by user'
const TRANSCRIPT_TAIL = 256 * 1024
export const STOPPED_TURN = 'the person stopped it (Escape)'
export const HELD_BACK = 'a hook held the message back'

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
function transcriptOf(
  ledger: Ledger,
  home: string,
  taskId: number,
  sessionId: string,
): string | null {
  const { account } = ledger.get(taskId)
  return transcriptPath(account === null ? configDir(home) : account || null, sessionId)
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
  queueTranscriptOnly: z.boolean().optional().catch(undefined),
  interruptedByShutdown: z.boolean().optional(),
  promptSubmitEnding: z.unknown().optional(),
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
      if (row.isMeta === true || row.queueTranscriptOnly === true) continue
      const local = /^<(command-|local-command-)/
      if (textsOf(row.message?.content).some((t) => typeof t === 'string' && local.test(t)))
        continue
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
// does one held back in the middle of a turn, a background agent's report say, which goes on past it:
// that comes right after a tool's result, where Claude Code gives a turn what waits for it (read from
// nod's own workers, 2.1.312 to 2.1.330).
export function endedWithoutStop(lines: string[]): string | null {
  let held = false
  for (const row of turnRows(lines)) {
    if (row.type === 'system') {
      held ||= row.promptSubmitEnding !== undefined
      continue
    }
    if (held) return row.type === 'user' && resultsOf(row).length > 0 ? null : HELD_BACK
    if (row.type === 'assistant') return null
    const stopped = textsOf(row.message?.content).some(
      (t) => typeof t === 'string' && t.startsWith(STOP_MARK),
    )
    return stopped && row.interruptedByShutdown !== true ? STOPPED_TURN : null
  }
  return held ? HELD_BACK : null
}

// The last message a hook held back in `lines`: when, what Claude Code shows of it, and the command of
// the hook that did: `UserPromptSubmit operation blocked by hook:`, `[<command>]: <its reason>`, the
// message's words last (2.1.328). NaN, '' and null once Claude Code keeps it otherwise.
export type HeldBack = { at: number; shown: string; hook: string | null }
export function lastHeldBack(lines: string[]): HeldBack | null {
  for (const row of turnRows(lines)) {
    if (row.promptSubmitEnding === undefined) continue
    const shown = typeof row.content === 'string' ? row.content : ''
    const hook = /^UserPromptSubmit .*:\n\[(.+?)\]: /.exec(shown)?.[1] ?? null
    return { at: Date.parse(row.timestamp ?? ''), shown, hook }
  }
  return null
}

// Whether a tool call of the last turn in `lines` still has no result: it runs, or its dialog shows.
// A turn's first message or the last one's end (`turn_duration`) is as far back as it looks.
// ponytail: a call whose result went with the Claude Code that ran it reads as running until the next
// turn; one before what nod reads (results that long of calls run at once) reads as none.
export function toolRuns(lines: string[]): boolean {
  const done = new Set<string>()
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

// The blocks of a transcript row's message, and the tool calls whose results it holds, by their ids.
const blocksOf = (row: Row) => (Array.isArray(row.message?.content) ? row.message.content : [])
const resultsOf = (row: Row): string[] =>
  blocksOf(row).flatMap((b) => ToolResult.safeParse(b).data?.tool_use_id ?? [])

// The text of a transcript message's `content`: a string, or the text blocks of a list.
const textsOf = (content: unknown): unknown[] =>
  Array.isArray(content)
    ? content.flatMap((b) => (b?.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    : [content]
