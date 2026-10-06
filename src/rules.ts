import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ledger, Task } from './ledger'

// Rules every worker gets after the built-in ones, one per line. They come from retrospectives the
// human approved, and the human may edit the file by hand.
export const rulesPath = (home: string): string => join(home, 'rules.md')

export function readRules(home: string): string {
  const path = rulesPath(home)
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
}

export function addRule(home: string, rule: string): void {
  appendFileSync(rulesPath(home), `- ${rule}\n`)
}

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
    'Turns:',
    ...turns,
    '',
    'Decisions:',
    ...(decisions.length > 0 ? decisions : ['- none']),
    '',
    'Rules every worker already gets:',
    ...quote(rules),
    '',
    'Propose at most one rule for future nod workers that would have avoided this trouble: general ' +
      'enough to help other tasks, one short line, not covered already. Do not change any files. ' +
      'Write the rule in the language of the brief, and end with `NOD: done | <the rule>`, or ' +
      '`NOD: done | none` when no general rule fits.',
  ].join('\n')
}
