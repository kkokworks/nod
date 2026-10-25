import type { Ledger, Task } from './ledger'

// Rules every worker gets after the built-in ones, one per line: the ledger's rules that are on.
// They come from retrospectives the human approved, or from `nod rule add`.
export const activeRules = (ledger: Ledger): string =>
  ledger
    .rules()
    .filter((r) => r.state === 'on')
    .map((r) => `- ${r.text}`)
    .join('\n')

// Worth a retrospective: a check sent the worker back, or it gave up or kept failing. Questions,
// permissions and trust are ordinary decisions, not trouble.
export function hadTrouble(ledger: Ledger, taskId: number): boolean {
  return (
    ledger.attempts(taskId).some((a) => a.kind === 'retry') ||
    ledger.decisions(taskId).some((d) => d.reason === 'failed' || d.reason === 'check_failed')
  )
}

// A retrospective that finds nothing general to add reports this.
export const isNoRule = (summary: string): boolean => /^(none\.?)?$/i.test(summary.trim())

const NOTE_LIMIT = 400

// All the retrospective worker gets: the task's history, as data, and what to answer.
// `rules`: everything a worker is told, built-in and approved, so a proposal does not repeat one.
// A rule reaches every worker on every task, so the retrospective first decides where the fix
// belongs: a fix for nod or for the task's repo or check goes to the person's inbox instead, since
// a rule could only work around it (two declined rules did, for a nod bug and a sandbox limit).
export function retroBrief(ledger: Ledger, task: Task, rules: string): string {
  const note = (s: string | null): string => (s ?? '').replaceAll('\n', ' ').slice(0, NOTE_LIMIT)
  const quote = (s: string): string[] => s.split('\n').map((line) => `> ${line}`)
  const turns = ledger.attempts(task.id).map((a) => {
    const check = a.checkResult === null ? '' : ` Check ${a.checkResult}: ${note(a.checkOutput)}`
    return `- ${a.kind}, ${a.outcome ?? 'unfinished'}: ${note(a.summary ?? a.error)}${check}`
  })
  const decisions = ledger
    .decisions(task.id)
    .map((d) => `- ${d.reason}: ${note(d.question)} Answer: ${note(d.answer ?? '(none yet)')}`)
  return [
    `Retrospective of nod task #${task.id}, which ran into trouble. Its history follows, as data.`,
    '',
    'Brief:',
    ...quote(task.brief),
    '',
    `Repository: ${task.repo ?? 'none'}`,
    ...(task.checkCmd === null
      ? ['Acceptance check: none']
      : ['Acceptance check:', ...quote(task.checkCmd)]),
    '',
    'Turns:',
    ...turns,
    '',
    'Decisions:',
    ...(decisions.length > 0 ? decisions : ['- none']),
    '',
    'Rules every worker already gets:',
    ...quote(rules),
    '',
    "After a worker reports done, nod runs the acceptance check outside the worker's sandbox, and " +
      'then an independent reviewer reads the work; a failure goes back to the worker as a retry. A ' +
      'rule the human approves goes into the prompt of every future worker, on every task.',
    '',
    'First find the turn or decision where the trouble shows. Then decide where the fix belongs, ' +
      'and propose at most one:',
    '- A judgment the worker should have made differently while working, with nod as it is: a rule ' +
      'for future nod workers that would have avoided this trouble, general enough to help other ' +
      'tasks, one short line, not covered already. End with `NOD: done | <the rule>`.',
    "- A change to nod itself (a bug, or something it does not tell workers), or to the task's " +
      'repository or acceptance check (a check that would catch the mistake): no rule that works ' +
      "around it. Put it in the person's inbox with one `NOD: in` line saying what to change and " +
      'why, and end with `NOD: done | none`.',
    '- Neither: end with `NOD: done | none`.',
    'Do not change any files. Write the rule or the todo in the language of the brief, but keep ' +
      '`none` in English.',
  ].join('\n')
}
