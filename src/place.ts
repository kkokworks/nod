import { basename, join } from 'node:path'
import type { Task } from './ledger'

// Where a task lives: its worker's tmux session, its workspace folder, its branch, and the folder its
// worker may keep Unix sockets in.

// A repo task's worktree is named after its repo and branch, so a folder says what it holds.
// ponytail: two repos with the same folder name and branch collide and `worktree add` fails; add
// the parent folder to the path if that happens.
export const workspaceOf = (home: string, task: Task): string =>
  task.repo === null
    ? join(home, 'work', String(task.id))
    : join(home, 'work', basename(task.repo), branchOf(task))

export function branchOf(task: Task): string {
  if (task.branch === null) throw new Error(`task n${task.id} has no branch`)
  return task.branch
}

export const sessionName = (taskId: number): string => `task-${taskId}`

// The one folder a worker's sandbox lets it make and reach Unix sockets in, so its tests can listen
// on a socket, which the sandbox refuses anywhere else (EPERM, 2.1.310). tmux makes its socket here
// too, but its server ends at once: the sandbox opens no pseudo-terminal for its window (2.1.312,
// test/tmux-server.ts).
// Its tests find it in NOD_SOCKETS (workerEnv). Each worker's own, in nod's home, where no other
// worker can write. Not the sandbox's TMPDIR, `/tmp/claude-<uid>` for every Claude Code session of
// the user, where any worker could remove or replace another's sockets, nor a folder in the
// worktree, whose path (the branch's) can leave too little of a socket path's 104 bytes (macOS):
// tmux takes 43 past its TMUX_TMPDIR in the tests. Made before Claude Code starts, so its tests can
// make theirs in it.
// ponytail: gc leaves the folder, as it leaves `.started-<task>`: what is in it is the worker's, and
// nod going through it outside the sandbox could follow a link the worker left to nod's own tmux
// server. A worker's sandbox now keeps no tmux server up in it (no pseudo-terminal); in one that
// did, a server a cut-off test run left would stay until the worker's next run ends it
// (test/tmux.ts), or until a reboot.
export const socketsDir = (home: string, taskId: number): string =>
  join(home, 'sockets', String(taskId))
