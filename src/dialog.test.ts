import { afterAll, expect, spyOn, test } from 'bun:test'
import { dialog } from '../test/dialog'
import { tempDirs } from '../test/tmp'
import { permissionQuestion } from './decisions'
import { dialogOn, WAIT } from './dialog'
import { onNotification } from './hooks'
import { Ledger } from './ledger'
import { Tmux } from './tmux'
import { answer } from './worker'

const tmp = tempDirs()
afterAll(tmp.removeAll)

// Tests whose dialog never comes or goes do not wait for it.
WAIT.dialogMs = 0

const OF_AGENT = 'Bash command · from the general-purpose agent'
// A subagent's dialog; `place`, in the queue.
const agents = (command: string, place = ''): string =>
  dialog(command, undefined, 120, OF_AGENT + place)
const HEAD = 'Claude needs your permission. Answer yes to allow; anything else denies.\n'
const words = (screen: string): string => HEAD + dialogOn(screen)?.text
const UNSEEN = `${HEAD}어느 명령인지 확인하지 못함 (nod attach n1)`

// A task whose worker's turn is open, in a terminal that shows `screens`, the next one each time it is
// read and the last from then on, and counts how often it was.
function running(...screens: (string | Error)[]) {
  const home = tmp.make('nod-dialog-')
  const ledger = new Ledger(home)
  const id = ledger.add({
    brief: 'look it up',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  ledger.setRunning(id, home)
  const attemptId = ledger.startAttempt({
    taskId: id,
    kind: 'start',
    decisionId: null,
    sessionId: 's1',
    prompt: 'look it up',
  })
  const terminal = { reads: 0, keys: [] as string[], screens }
  const terminals = Object.assign(Tmux.of(home), {
    alive: () => true,
    option: () => '',
    keys: (_: string, ...keys: string[]) => {
      terminal.keys.push(...keys)
    },
    screen: () => {
      const screen = terminal.screens[Math.min(terminal.reads, terminal.screens.length - 1)] ?? ''
      terminal.reads += 1
      if (screen instanceof Error) throw screen
      return screen
    },
  })
  const show = (...next: (string | Error)[]): void => {
    Object.assign(terminal, { reads: 0, screens: next })
  }
  const notified = () =>
    onNotification(ledger, home, terminals, {
      session_id: 's1',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission',
    })
  const open = () => ledger.decisions(id).filter((d) => d.answer === null)
  const asked = () => open().map((d) => d.question)
  const yes = (n: number) => answer(ledger, home, terminals, open()[n]?.id ?? 0, 'yes', 'human')
  // As the PermissionRequest hook opens the main thread's (onPermissionAsk).
  const hooked = (tool: string, input: Record<string, unknown>) =>
    ledger.ask(id, attemptId, 'permission', permissionQuestion(tool, input))
  return { home, ledger, id, attemptId, terminal, show, notified, asked, yes, hooked }
}

// Nod's own wait, long, in a test whose screen ends it.
async function waiting(run: () => Promise<unknown>): Promise<void> {
  WAIT.dialogMs = 60_000
  try {
    await run()
  } finally {
    WAIT.dialogMs = 0
  }
}

const ONE = "sed -n '1,140p' src/a.ts"
const TWO = "sed -n '30,125p' src/a.ts"

test('nod reads the dialog on the screen: what it asks and who asks, and compares it whatever its width, its place in the queue and its time left', () => {
  const one = dialogOn(agents(ONE, '     1 of 2'))
  expect(one).toMatchObject({ subagents: true, more: true })
  expect(one?.text).toStartWith(` ${OF_AGENT}     1 of 2\n Show it\n`)
  expect(one?.text).toContain(ONE)
  expect(one?.text).toEndWith(' ❯ 1. Yes\n   2. No')
  // Not what was there before it.
  expect(one?.text).not.toContain('⎿')

  for (const screen of [
    agents(ONE),
    agents(ONE, '   2 of 2'),
    dialog(ONE, undefined, 60, OF_AGENT),
    agents(ONE).replace('1:53', '0:09'),
    agents(ONE).replace(/ ⚠.*\n/, ''),
    agents(ONE).replace(' ❯ 1. Yes\n   2.', '   1. Yes\n ❯ 2.'),
    `${agents(TWO)}\n${agents(ONE)}\n\n Esc to cancel · Tab to amend\n\n\n`,
  ]) {
    expect([screen, dialogOn(screen)?.asks]).toEqual([screen, one?.asks])
    expect(dialogOn(screen)?.more).toBe(false)
  }
  expect(dialogOn(agents(TWO))?.asks).not.toBe(one?.asks)
  expect(dialogOn(dialog(ONE))?.asks).not.toBe(one?.asks)

  for (const [title, subagents] of [
    ['Bash command', false],
    ['Bash command · from the tidy plugin', false],
    ['Bash command · from the Explore agent', true],
    ['Bash command · from a subagent', true],
    ['Edit file · from the "review" workflow', true],
    ['Bash command · from a workflow', true],
  ] as const) {
    expect([title, dialogOn(dialog(ONE, undefined, 80, title))?.subagents]).toEqual([
      title,
      subagents,
    ])
  }

  // None; one half drawn; one whose top is out of sight; what only looks like its answers.
  const rule = '─'.repeat(60)
  for (const screen of [
    '',
    `● Done.\n\n${rule}\n❯ \n${rule}\n  ? for shortcuts`,
    `${rule}\n❯ \n────────a.ts | head -90\n╌╌╌╌╌╌╌╌╌╌╌╌\n │ Auto mode needs your confirmation`,
    agents(ONE).split('\n').slice(3).join('\n'),
    `${rule}\n 1. first\n 2. second\n`,
  ]) {
    expect([screen, dialogOn(screen)]).toEqual([screen, null])
  }
})

test('of two dialogs a subagent’s calls wait in, each gets its decision once it shows, in its own words; the Notification of the one behind opens none', async () => {
  const { show, notified, asked, yes, terminal, ledger, id } = running()
  const [first, second] = [agents(ONE, '     1 of 2'), agents(TWO)]
  show(first)
  await notified()
  await notified()
  expect(asked()).toEqual([words(first)])
  expect(asked()[0]).not.toContain(TWO)

  // Its answer: the one behind shows after a moment, and has its decision at once.
  show(first, first, '', second)
  await waiting(() => yes(0))
  expect(terminal.keys).toEqual(['Enter'])
  expect(asked()).toEqual([words(second)])
  expect(ledger.get(id).status).toBe('needs_decision')
  // Its own Notification, as it shows, opens no other.
  await notified()
  expect(asked()).toEqual([words(second)])
  await waiting(() => yes(0))
  expect(terminal.keys).toEqual(['Enter', 'Enter'])
  expect(asked()).toEqual([])
})

test('the dialog behind one answered in the terminal gets a decision with its own Notification, beside the one left open', async () => {
  const { show, notified, asked } = running()
  show(agents(ONE, '     1 of 2'))
  await notified()
  show(agents(TWO))
  await notified()
  await notified()
  expect(asked()).toEqual([words(agents(ONE, '     1 of 2')), words(agents(TWO))])
})

test('two Notifications that read the screen at once open one decision', async () => {
  const { home, ledger, id, attemptId, show, notified, asked } = running()
  show(agents(ONE))
  // The other's hook, in its own process, opens it right after this one saw none.
  const look = ledger.decisions.bind(ledger)
  const other = new Ledger(home)
  const spy = spyOn(ledger, 'decisions').mockImplementationOnce((task) => {
    const seen = look(task)
    other.ask(id, attemptId, 'permission', words(agents(ONE)))
    return seen
  })
  try {
    await notified()
  } finally {
    spy.mockRestore()
  }
  expect(asked()).toEqual([words(agents(ONE))])
})

test('a Notification that comes as its dialog was answered opens nothing once it is gone; the next one’s opens its own; one that stays is asked again', async () => {
  const { show, notified, asked, yes, terminal } = running()
  const answered = async () => {
    show(agents(ONE))
    await notified()
    await yes(0)
    expect(asked()).toEqual([])
  }
  await answered()
  show(agents(ONE), agents(ONE), '● Reading')
  await waiting(notified)
  expect(asked()).toEqual([])
  expect(terminal.reads).toBe(3)

  show(agents(ONE), agents(TWO))
  await waiting(notified)
  expect(asked()).toEqual([words(agents(TWO))])
  show(agents(TWO))
  await yes(0)

  // The key did not reach it.
  show(agents(TWO))
  await notified()
  expect(asked()).toEqual([words(agents(TWO))])
})

test('a decision on a dialog nod cannot read says so, and shows no other command; it waits for one to be drawn', async () => {
  const other = '  Bash(rm -rf src)\n  ⎿  Running…\n'
  const gone = new Error('tmux capture-pane failed')
  for (const screen of [other, `${other}${'─'.repeat(60)}\n❯ 1\n${'─'.repeat(60)}`, gone]) {
    const { show, notified, asked } = running(screen)
    await notified()
    expect(asked()).toEqual([UNSEEN])
    await notified()
    show(agents(ONE))
    await notified()
    expect(asked()).toEqual([UNSEEN])
  }
  const { terminal, notified, asked } = running(other, '', agents(ONE))
  await waiting(notified)
  expect(asked()).toEqual([words(agents(ONE))])
  expect(terminal.reads).toBe(3)
})

test('a subagent’s dialog that shows before the main thread’s gets its own decision; the main thread’s, whose hook opened it, no other', async () => {
  const { show, notified, asked, hooked } = running()
  hooked('Bash', { command: 'git push' })
  const main = permissionQuestion('Bash', { command: 'git push' })
  for (const screen of [dialog('git push'), dialog('git push --force'), '']) {
    show(screen)
    await notified()
    expect([screen, asked()]).toEqual([screen, [main]])
  }
  // Also one of the same command.
  for (const screen of [agents('git push'), agents('git push'), dialog('git push')]) {
    show(screen)
    await notified()
    expect(asked()).toEqual([main, words(agents('git push'))])
  }
})

test('a yes goes only to the dialog its decision is about: while another shows it is refused, and nothing is typed', async () => {
  const { show, notified, asked, yes, hooked, terminal, ledger, id } = running()
  const [a = 0, b = 0] = ['git push', 'git push --tags'].map((command) =>
    hooked('Bash', { command }),
  )
  // Two of the main thread's at once: the first shows.
  show(dialog('git push', undefined, 80, 'Bash command    1 of 2'))
  await expect(yes(1)).rejects.toThrow(
    `n1's terminal shows another dialog than d${b}'s: answer d${a} first`,
  )
  expect(terminal.keys).toEqual([])
  expect(asked()).toHaveLength(2)
  expect(ledger.get(id).status).toBe('needs_decision')
  await yes(0)
  show(dialog('git push --tags'))
  await yes(0)
  expect(terminal.keys).toEqual(['Enter', 'Enter'])

  // A subagent's, which another one's or the main thread's decision is not about.
  show(agents(ONE))
  await notified()
  const c = ledger.decisions(id).at(-1)?.id
  hooked('Bash', { command: ONE })
  await expect(yes(1)).rejects.toThrow(`answer d${c} first`)
  show(agents(TWO))
  await expect(yes(0)).rejects.toThrow(
    `n1's terminal shows another dialog than d${c}'s: look at it (nod attach n1) first`,
  )
  show(dialog(ONE))
  await expect(yes(0)).rejects.toThrow('shows another dialog')
  expect(terminal.keys).toEqual(['Enter', 'Enter'])
  expect(asked()).toHaveLength(2)

  // Drawn otherwise since: narrower, and its place in the queue and time left.
  show(dialog(ONE, undefined, 60, OF_AGENT).replace('1:53', '0:02'))
  await yes(0)
  // No dialog nod can read, as before.
  show('')
  await yes(0)
  expect(terminal.keys).toHaveLength(4)
  expect(asked()).toEqual([])
})

test('a yes to another tool’s decision, or a short command’s, does not go to a Bash command’s dialog that holds neither', async () => {
  const { show, yes, hooked, terminal } = running()
  const long = `git commit -m "${'x'.repeat(3000)}"`
  hooked('Bash', { command: 'git status' })
  hooked('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' })
  hooked('Bash', { command: long })
  show(dialog(`${long.slice(0, 1000)}…`))
  const look = "n1's terminal shows another dialog than d1's: look at it (nod attach n1) first"
  await expect(yes(0)).rejects.toThrow(look)
  await expect(yes(1)).rejects.toThrow('look at it')
  expect(terminal.keys).toEqual([])
  await yes(2)
  expect(terminal.keys).toEqual(['Enter'])
})

test('the dialog behind one answered gets no decision on a turn that ended meanwhile', async () => {
  const { home, ledger, show, notified, asked, attemptId, terminal } = running()
  show(agents(ONE, '     1 of 2'))
  await notified()
  const ends = Object.assign(Tmux.of(home), {
    keys: () => {
      ledger.endAttempt(attemptId, { outcome: 'succeeded', summary: '', report: '' })
      show(agents(TWO))
    },
    screen: () => terminal.screens[0] as string,
  })
  await waiting(() => answer(ledger, home, ends, 1, 'yes', 'human'))
  expect(asked()).toEqual([])
})

test('a yes goes to a dialog nod cannot tell from its decision’s: a long command’s, another tool’s, one it could not read, one worded before', async () => {
  const { show, notified, asked, yes, hooked, terminal, ledger, id, attemptId } = running()
  const long = `echo ${'x'.repeat(3000)}`
  hooked('Bash', { command: long })
  show(dialog(`${long.slice(0, 1000)}…`))
  await yes(0)
  hooked('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' })
  show(dialog('1 - a\n2 + b', undefined, 80, 'Edit file'))
  await yes(0)
  show('')
  ledger.ask(id, attemptId, 'permission', 'Claude needs your permission to use Bash')
  await yes(0)
  expect(terminal.keys).toHaveLength(3)
  // As until 2026-11-25, with the end of the screen.
  for (const end of [12, 14, 16]) {
    const tail = agents(ONE).split('\n').slice(-end).join('\n')
    ledger.ask(id, attemptId, 'permission', `${HEAD}${tail}`)
    show(agents(ONE))
    await yes(0)
  }
  expect(terminal.keys).toHaveLength(6)
  show('')
  const none = running('')
  await none.notified()
  none.show(agents(ONE))
  await none.yes(0)
  expect(none.terminal.keys).toEqual(['Enter'])
  await notified()
  expect(asked()).toEqual([])
})

test('a yes waits for no dialog behind when none waits, or when another decision of the turn is open', async () => {
  const { show, notified, yes, hooked, terminal, asked } = running()
  show(agents(ONE))
  await notified()
  show(agents(ONE))
  await waiting(() => yes(0))
  expect(terminal.reads).toBe(1)

  hooked('Bash', { command: 'git push' })
  show(agents(TWO, '     1 of 2'))
  await notified()
  show(agents(TWO, '     1 of 2'))
  await waiting(() => yes(1))
  expect(terminal.reads).toBe(1)
  expect(asked()).toEqual([permissionQuestion('Bash', { command: 'git push' })])
})
