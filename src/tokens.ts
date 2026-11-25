import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { FINISHED, type Ledger, type Task } from './ledger'
import { message } from './proc'
import { jsonOrNull } from './report'
import { reviewedTask } from './review'
import { subagentsOf, transcriptOf } from './transcript'
import { clean } from './view'

// The tokens the model calls of tasks used, counted from Claude Code's transcripts each time they
// are asked for: the ledger keeps none of it. Of a transcript it takes what each call used and which
// subagents it started, and of a session that may be a review how its first message starts, nod's
// own words (reviewedTask). Nothing of it is priced: prices change.

// The worker's own calls, those of the subagents it started, and the independent reviews' (with the
// subagents those started).
const PARTS = ['worker', 'subagents', 'review'] as const
type Part = (typeof PARTS)[number]
type Use = { calls: number; output: number; cacheWrite: number; cacheRead: number; input: number }
// By part, then model. null: there is no transcript of that part, so nothing says what it used.
export type Tokens = Record<Part, Record<string, Use> | null>

const none = (): Tokens => ({ worker: null, subagents: null, review: null })
// With no prototype, whose names a model's may be.
const noCalls = (): Record<string, Use> => Object.create(null)

// A call to the model as Claude Code keeps it: an assistant row for each block of the response, every
// one with the response's ID and the whole of its usage (2.1.309 to 2.1.332: of 170,038 rows past a
// response's first, none had another usage).
// ponytail: a row Claude Code words otherwise one day reads as no call.
const Call = z.object({
  type: z.literal('assistant'),
  timestamp: z.string(),
  message: z.object({
    id: z.string(),
    model: z.string(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullish(),
      cache_read_input_tokens: z.number().nullish(),
    }),
  }),
})
// What Claude Code writes itself into the place of a response (an API error, say).
const SYNTHETIC = '<synthetic>'
// A tool's result that names the subagent it started. The ID is printed, and a server's tool may put
// any words there: only what can name a file.
const Started = z.object({ toolUseResult: z.object({ agentId: z.string().regex(/^[\w-]+$/) }) })
// A message of the person's, or of nod's.
const User = z.object({
  type: z.literal('user'),
  message: z.object({ content: z.string().catch('') }),
})

// What a task used, and the sessions and subagents it had that no transcript is left of.
export function taskTokens(
  ledger: Ledger,
  home: string,
  task: Task,
): { tokens: Tokens; missing: string[] } {
  const tokens = none()
  return { tokens, missing: addTask(tokens, ledger, home, task, 0) }
}

// What the tasks' calls since `since` used together, and which of the tasks with a turn or an end
// since then, or no end yet, have a session or subagent with no transcript, or one that cannot be read
// (which goes to stderr).
export function tokensSince(
  ledger: Ledger,
  home: string,
  since: Date,
): { since: string; missing: string[] } & Tokens {
  const tokens = none()
  const missing: string[] = []
  const from = since.toISOString()
  const now = new Date().toISOString()
  for (const task of ledger.list()) {
    // Not by its turns alone: the review of one runs once that is closed (settle in worker.ts).
    const end = FINISHED.has(task.status) ? (task.finishedAt ?? '') : now
    const turns = ledger.attempts(task.id).map((a) => a.finishedAt ?? a.startedAt)
    if (![end, ...turns].some((at) => at >= from)) continue
    try {
      if (addTask(tokens, ledger, home, task, since.getTime()).length > 0)
        missing.push(`n${task.id}`)
    } catch (error) {
      console.error(`nod: could not read the transcripts of task n${task.id}: ${message(error)}`)
      missing.push(`n${task.id}`)
    }
  }
  return { since: from, ...tokens, missing }
}

// Adds what the task's calls since `since` used to `total`, and returns what has no transcript. A
// response counts once for its ID, the worker's first: a subagent's transcript may hold one of its
// worker's too (2.1.312).
function addTask(total: Tokens, ledger: Ledger, home: string, task: Task, since: number): string[] {
  const seen = new Set<string>()
  // Returns the subagents started in `files`.
  const add = (part: Part, files: string[]): string[] => {
    const started: string[] = []
    for (const file of files) {
      const models = total[part] ?? noCalls()
      total[part] = models
      for (const line of linesOf(file)) {
        if (line.includes('"toolUseResult"') && line.includes('"agentId":"')) {
          const id = Started.safeParse(jsonOrNull(line)).data?.toolUseResult.agentId
          if (id !== undefined) started.push(id)
        }
        const call = line.includes('"usage"') ? Call.safeParse(jsonOrNull(line)).data : undefined
        if (call === undefined) continue
        const { id, model, usage } = call.message
        if (model === SYNTHETIC || seen.has(id) || Date.parse(call.timestamp) < since) continue
        seen.add(id)
        const use = models[model] ?? { calls: 0, output: 0, cacheWrite: 0, cacheRead: 0, input: 0 }
        models[model] = use
        use.calls++
        use.output += usage.output_tokens
        use.cacheWrite += usage.cache_creation_input_tokens ?? 0
        use.cacheRead += usage.cache_read_input_tokens ?? 0
        use.input += usage.input_tokens
      }
    }
    return started
  }

  const missing: string[] = []
  const workers: string[] = []
  for (const session of new Set(ledger.attempts(task.id).map((a) => a.sessionId))) {
    const file = transcriptOf(ledger, home, task.id, session)
    if (file === null) missing.push(`session ${session}`)
    else workers.push(file)
  }
  // Adds the sessions' calls to `part` and their subagents' to `within`, and returns the subagents
  // with no transcript.
  const addAll = (part: Part, sessions: string[], within: Part): string[] => {
    const subagents = sessions.flatMap(subagentsOf)
    const started = [...add(part, sessions), ...add(within, subagents)]
    const kept = new Set(subagents.map((f) => basename(f)))
    return [...new Set(started)].filter((id) => !kept.has(`agent-${id}.jsonl`))
  }
  const lost = addAll('worker', workers, 'subagents')
  // The sessions' transcripts are all there and name no other: they started none.
  if (workers.length > 0 && missing.length + lost.length === 0) total.subagents ??= noCalls()
  lost.push(...addAll('review', reviewsOf(task.id, workers), 'review'))
  return [...missing, ...lost.map((id) => `subagent ${id}`)]
}

// What is read of a line is ASCII, and as UTF-8 a week of them took half as long again.
const linesOf = (file: string): string[] => readFileSync(file, 'latin1').split('\n')

// The transcripts of the task's reviews. The ledger has no session of theirs, but the reviewer runs
// in the worker's folder as the worker's account (review in verify.ts), so Claude Code keeps theirs
// beside the worker's.
// ponytail: one that is gone while others are there goes unnoticed: nothing counts the reviews.
function reviewsOf(taskId: number, workers: string[]): string[] {
  const own = new Set(workers)
  return [...new Set(workers.map((f) => dirname(f)))]
    .flatMap((dir) => readdirSync(dir).map((f) => join(dir, f)))
    .filter((f) => f.endsWith('.jsonl') && !own.has(f) && reviewedTask(firstMessage(f)) === taskId)
}

// The first message of a session's transcript; '' for none, or one that is more than its words.
function firstMessage(file: string): string {
  for (const line of linesOf(file)) {
    const row = User.safeParse(jsonOrNull(line)).data
    if (row !== undefined) return row.message.content
  }
  return ''
}

// What a task used (taskTokens) as `nod show` prints it.
export function tokenLines({ tokens, missing }: { tokens: Tokens; missing: string[] }): string[] {
  const n = (count: number): string => count.toLocaleString('en-US')
  const lines = PARTS.flatMap((part) => {
    const models = tokens[part]
    if (models === null) return [`tokens ${part}: no transcript`]
    const uses = Object.entries(models)
    if (uses.length === 0) return [`tokens ${part}: no calls`]
    return uses.map(
      ([model, u]) =>
        `tokens ${part} ${clean(model)}: calls ${n(u.calls)}, output ${n(u.output)}, cache write ${n(u.cacheWrite)}, cache read ${n(u.cacheRead)}, input ${n(u.input)}`,
    )
  })
  return missing.length === 0 ? lines : [...lines, `tokens: no transcript of ${missing.join(', ')}`]
}
