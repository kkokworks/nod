import { join } from 'node:path'
import { quote } from './tmux'
import { SANDBOX } from './verify'

// The Claude Code settings (`--settings`) of a worker's session, its sandbox and hooks
// (workerSettings), and of a project session nod open starts, its hooks (openSettings), with the
// `nod hook` command each hook runs. What nod does as each hook comes is in hooks.ts. worker.ts
// and todo-cli.ts both start sessions with these, so they are here rather than in either.

// The check and the review both run inside the Stop hook, so the hook outlasts them
// (REVIEW_TIMEOUT_MS in verify.ts).
export const STOP_HOOK_TIMEOUT_SECS = 1800
// Opening the ledger (its busy_timeout, 5 s) and a send (inbox.ts, 5 s), with room to spare.
const INBOX_HOOK_SECS = 15
// The permission hook sends what it allowed, or opens a decision, which also runs <home>/notify
// (10 s). The dialog shows while it runs, so its time holds up no one.
const PERMISSION_HOOK_SECS = 30
// The standard `dirname`, not Bun's `dir`: the UI server loads this module through Vite, which
// gives only the standard names.
export const CLI = join(import.meta.dirname, 'cli.ts')

// `started`: a file the SessionStart hook creates, so nod knows the session got past the trust
// dialog. Claude Code runs SessionStart hooks again once it has compacted the conversation, with
// the matcher `compact` (2.1.310), for onCompact. `sockets`: the worker's socketsDir.
export function workerSettings(started: string | null, sockets: string): string {
  const touch = (file: string) => [
    { hooks: [{ type: 'command', command: `touch ${quote(file)}` }] },
  ]
  return JSON.stringify({
    sandbox: {
      ...SANDBOX,
      filesystem: { allowWrite: [sockets] },
      network: { ...SANDBOX.network, allowUnixSockets: [sockets] },
    },
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: hook('stop'), timeout: STOP_HOOK_TIMEOUT_SECS }] },
      ],
      Notification: [{ hooks: [{ type: 'command', command: hook('notification') }] }],
      // Every tool's prompts: nod allows only Bash commands (allow.ts), and any prompt it does not
      // becomes a decision here (onPermissionAsk). Claude Code shows the prompt while the hook runs,
      // and the Notification for it comes only after it has waited about 6 s (docs).
      PermissionRequest: [
        {
          hooks: [{ type: 'command', command: hook('permission'), timeout: PERMISSION_HOOK_SECS }],
        },
      ],
      // A tool that ran, as it did or failing: its dialog, if it had one, was answered (onToolRan).
      PostToolUse: [{ hooks: [{ type: 'command', command: hook('tool') }] }],
      PostToolUseFailure: [{ hooks: [{ type: 'command', command: hook('tool') }] }],
      StopFailure: [{ hooks: [{ type: 'command', command: hook('stop-failure') }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook('prompt') }] }],
      SessionStart: [
        { matcher: 'compact', hooks: [{ type: 'command', command: hook('compact') }] },
        ...(started === null ? [] : touch(started)),
      ],
    },
  })
}

// The command a Claude Code hook runs: `nod hook <event>`, by this nod.
const hook = (event: string): string => `${quote(process.execPath)} ${quote(CLI)} hook ${event}`

// What `nod open` gives a project session: hooks that tell nod where the session takes messages as
// it starts (startup, resume, compact: Claude Code exports the socket to hooks before any runs), and
// that it takes none once it ends (onInbox in inbox.ts). SessionEnd hooks share a
// budget of 1.5 s unless one sets a longer timeout (docs), less than a busy ledger may wait for.
export function openSettings(): string {
  const inbox = [{ hooks: [{ type: 'command', command: hook('inbox'), timeout: INBOX_HOOK_SECS }] }]
  return JSON.stringify({ hooks: { SessionStart: inbox, SessionEnd: inbox } })
}
