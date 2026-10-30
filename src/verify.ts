import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  conflictBrief,
  gitPath,
  headOf,
  NOD_GIT,
  ownStart,
  rebasing,
  unmergedFiles,
} from './branch'
import type { Ledger, Task } from './ledger'
import { branchOf } from './place'
import { OUTPUT_LIMIT, spawn } from './proc'
import { PR_TEXT, parseReport, prText, TEXT_ONLY } from './report'
import { type Changes, reviewBrief } from './review'

// How nod checks a worker's done before it counts (settle in worker.ts): the task's acceptance
// check, that a repo task's work is committed, then an independent review; for landing work
// (land.ts), first the rebase going on and the pull request's text. What the reviewer is told is
// in review.ts.

// The OS sandbox is the boundary, not a command allowlist: once a worker may run tests it can run
// anything, so limit where it can write and what it can reach instead. Measured on 2.1.289:
// writes outside the workspace and network to unlisted domains fail; worktree commits still work.
// The reviewer runs in it as it is; a worker's settings add its sockets folder (workerSettings in
// worker.ts).
export const SANDBOX = {
  enabled: true,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: false,
  network: { allowedDomains: ['registry.npmjs.org'] },
}

// The check and the review both run inside the Stop hook, so the hook outlasts them
// (STOP_HOOK_TIMEOUT_SECS in worker.ts).
const REVIEW_TIMEOUT_MS = 600_000
// What `claude -p` prints first when a hook blocks the message it was given (2.1.310).
const BLOCKED = 'UserPromptSubmit operation blocked by hook:'

// What nod checks itself before a "done" counts: the task's check command, then, in a repo, that
// the work is committed, since later tasks start from the branch and gc keeps only commits, then
// an independent review. Null for a retrospective, whose rule the human decides on instead.
// What a check of a done came to. `next`: the landing goes on with more work for the worker, not a
// failure (verifyLanding): a rebase nod went on with stopped at another conflict, or the pull
// request's text is due; `head`: the head that passed.
export type Check = { passed: boolean; output: string; next?: boolean; head?: string }

// `checkCmd`: the task's, or as it lands the repo's (verifyLanding).
export async function verify(
  ledger: Ledger,
  task: Task,
  report: string,
  checkCmd: string | null = task.checkCmd,
): Promise<Check | null> {
  if (task.retroId !== null) return null
  if (task.workspace === null) throw new Error(`task n${task.id} has no workspace`)
  // ponytail: the check runs unsandboxed because a human wrote it; sandbox it once the planner
  // starts generating checks.
  const check = checkCmd === null ? null : await runCheck(checkCmd, task.workspace)
  if (check !== null && !check.passed) {
    return {
      passed: false,
      output: `The acceptance check \`${checkCmd}\` failed:\n${check.output}`,
    }
  }
  const uncommitted = task.repo === null ? '' : await uncommittedChanges(task.workspace)
  if (uncommitted) {
    return {
      passed: false,
      output: `These changes are not committed:\n${uncommitted}\nCommit them on this branch.`,
    }
  }
  const verdict = await review(ledger, task, task.workspace, report)
  if (!verdict.passed) {
    return {
      passed: false,
      output: `An independent review of your work failed:\n${verdict.output}`,
    }
  }
  return { passed: true, output: `${check?.output ?? ''}\nReview: ${verdict.output}`.trim() }
}

// A reviewer that has none of the worker's context reads the work against what the human asked, so
// a worker cannot pass by weakening its tests or claiming more than it did. It runs headless: it
// only gives a verdict, which reaches the worker like a failed check, so it has no context to keep.
// It fails loudly rather than passing work it could not judge.
async function review(
  ledger: Ledger,
  task: Task,
  cwd: string,
  report: string,
): Promise<{ passed: boolean; output: string }> {
  // Since the branch now starts, once nod rebased it as it lands it (land.ts).
  const base = ledger.landing(task.id)?.base ?? null
  // A folder of the review's own for the diff it reads (changesOf), which it is let read. Through no
  // link (macOS keeps temp folders behind one), so the folder it is let read and the file in it are
  // one path however Claude Code compares them.
  const dir = task.repo === null ? null : realpathSync(mkdtempSync(join(tmpdir(), 'nod-review-')))
  try {
    const changes = dir === null ? null : await changesOf(cwd, branchOf(task), base, dir)
    const { code, stdout, output } = await spawn(
      [
        'claude',
        '-p',
        '--settings',
        JSON.stringify({ sandbox: SANDBOX }),
        ...(task.model === null ? [] : ['--model', task.model]),
        ...(dir === null ? [] : ['--add-dir', dir]),
        '--disallowedTools',
        'Edit',
        'Write',
        'NotebookEdit',
      ],
      cwd,
      { stdin: reviewBrief(ledger, task, report, changes), timeoutMs: REVIEW_TIMEOUT_MS },
    )
    if (code !== 0) {
      throw new Error(`the review exited with ${code}: ${output.slice(-OUTPUT_LIMIT)}`)
    }
    // A hook that blocks the first message (a user's UserPromptSubmit hook): no model runs, and
    // Claude Code exits 0 with why, then the whole message (2.1.310), which only brings back the
    // brief and the report, so the error has why alone. Why ends it, after the hook's command.
    if (stdout.startsWith(BLOCKED)) {
      const why = stdout.slice(BLOCKED.length).split('\nOriginal prompt: ')[0]?.trim() ?? ''
      throw new Error(
        `the reviewer's first message was blocked by a hook, so no review ran: ${why.slice(-OUTPUT_LIMIT)}`,
      )
    }
    // ponytail: a repo's reviewer is told not to touch the worktree and checked afterwards; give it
    // a worktree of its own if it needs to run things.
    if (
      changes !== null &&
      ((await headOf(cwd)) !== changes.head || (await uncommittedChanges(cwd)))
    ) {
      throw new Error(`the reviewer of task n${task.id} changed its worktree`)
    }
    const verdict = parseReport(stdout)
    if (verdict === null || verdict.status === 'question') {
      throw new Error(`the review gave no verdict: ${stdout.slice(-OUTPUT_LIMIT)}`)
    }
    if (verdict.status === 'done') return { passed: true, output: verdict.text }
    return { passed: false, output: stdout.trim().slice(-OUTPUT_LIMIT) }
  } finally {
    if (dir !== null) rmSync(dir, { recursive: true, force: true })
  }
}

// What the branch changed since its own commits start (ownStart, from `base`, where nod rebased it
// to as it lands it, once there is one), with the diff saved in `dir`. The reviewer reads that file
// with its Read tool rather than running git: a user's hook may rewrite the shell commands it runs,
// and one that shortens their output cut lines out of the diff. No color and no external diff tool,
// whatever the human's git config says, so the diff is plain.
async function changesOf(
  worktree: string,
  branch: string,
  base: string | null,
  dir: string,
): Promise<Changes> {
  const git = async (...args: string[]): Promise<string> => {
    const { code, stdout, output } = await spawn(['git', ...args], worktree)
    if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${output.trim()}`)
    return stdout
  }
  const head = (await git('rev-parse', 'HEAD')).trim()
  const start = await ownStart(worktree, branch, head, 'refs/remotes/origin/HEAD', base)
  if (start === null) throw new Error(`${branch}'s reflog no longer says where it was created`)
  const range = `${start}..${head}`
  const saved = join(dir, 'changes.diff')
  writeFileSync(saved, await git('diff', '--no-color', '--no-ext-diff', range))
  return { start, head, stat: await git('diff', '--no-color', '--stat', range), saved }
}

// A done of landing work (land.ts), checked as the branch now lands. A rebase whose conflict the
// worker resolved goes on, and stops again at the next one. What the worker changed since the head
// nod last checked passes the check (the repo's full one, else the task's) and the independent
// review, both on the commits since the branch now starts. Until nod opens the pull request, the
// done brings its text: from a done with its report line (one that follows a blocked stop often
// leaves the line out, and the text with it), in a turn nod asked for the text (`prompt`), which
// asks for nothing else. Other words that end landing work (a resolved conflict, an answer, a tell,
// a fixed check) report on that work; their first line would be no title.
export async function verifyLanding(
  ledger: Ledger,
  task: Task,
  report: string,
  reported: boolean,
  prompt: string,
): Promise<Check | null> {
  const ws = task.workspace
  if (ws === null) throw new Error(`task n${task.id} has no workspace`)
  if (task.repo === null) return verify(ledger, task, report)
  // Only while there is none: a later done of the same landing (a second conflict, a fixed check)
  // reports on that work, not on the pull request. A gate that fails clears it (land.ts).
  const pr = reported && prompt.includes(PR_TEXT) ? prText(report) : null
  const had = ledger.landing(task.id)
  if (pr !== null && had?.pr === null && had.title === null) ledger.setLanding(task.id, pr)
  if (rebasing(ws)) {
    const unmerged = await unmergedFiles(ws)
    if (unmerged !== '') {
      return {
        passed: false,
        output: `These files are still unmerged:\n${unmerged}\nResolve each and stage it with \`git add <file>\`; nod goes on with the rebase once none is left.`,
      }
    }
    const onto = readFileSync(gitPath(ws, 'rebase-merge/onto'), 'utf8').trim()
    const r = await spawn([...NOD_GIT, 'rebase', '--continue'], ws)
    if (r.code !== 0) {
      // Stopped at the next commit's conflict: the landing goes on. Anything else (an unstaged
      // change left beside the resolution, say) is the worker's to fix, as a failed check is, so
      // it counts toward the retries and git says why.
      const next = await unmergedFiles(ws)
      if (rebasing(ws) && next !== '') {
        return { passed: false, next: true, output: await conflictBrief(ws) }
      }
      return {
        passed: false,
        output: `git rebase --continue failed:\n${r.output.slice(-OUTPUT_LIMIT)}`,
      }
    }
    ledger.setLanding(task.id, { base: onto, ready: null })
  }
  const landing = ledger.landing(task.id)
  // Asked now, once the work nod asked for is done: the landing going on. Asked again, a turn that
  // was to bring it and did not, as a failure to fix.
  if (landing?.pr === null && landing.title === null) {
    return { passed: false, output: `${PR_TEXT}\n\n${TEXT_ONLY}`, next: !prompt.includes(PR_TEXT) }
  }
  const head = await headOf(ws)
  if (head === landing?.ready && (await uncommittedChanges(ws)) === '') {
    return { passed: true, output: 'nothing changed since nod checked it', head }
  }
  const check = ledger.repo(task.repo)?.checkCmd ?? task.checkCmd
  const verdict = await verify(ledger, task, report, check)
  return verdict === null ? null : { ...verdict, head }
}

async function runCheck(cmd: string, cwd: string): Promise<{ passed: boolean; output: string }> {
  const { code, output } = await spawn(['sh', '-c', cmd], cwd)
  return { passed: code === 0, output: output.slice(-OUTPUT_LIMIT) }
}

async function uncommittedChanges(worktree: string): Promise<string> {
  const { code, stdout, output } = await spawn(['git', 'status', '--porcelain'], worktree)
  if (code !== 0) throw new Error(`git status failed: ${output.trim()}`)
  return stdout.trim().slice(-OUTPUT_LIMIT)
}
