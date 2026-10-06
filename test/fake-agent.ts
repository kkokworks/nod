// Stands in for interactive `claude` in tests. Each message is a turn: words in its first line pick
// the reply, so context nod adds below cannot, then the hooks from --settings run as in Claude
// Code, and a hook that blocks the stop starts a continuation. Between turns it reads what is typed
// into its terminal. With $FAKE_AGENT_UNTRUSTED set, a new session first shows the trust dialog.
// Every launch and turn is logged to $FAKE_AGENT_LOG.
import { appendFileSync, writeFileSync } from 'node:fs'

type Hooks = Record<string, { hooks: { command: string }[] }[]>

const ENTER = '\r'
const ESCAPE = '\x1b'
const DOWN = '\x1b[B'
// A fixed identity and no hooks, so commits do not depend on this machine's git config.
const GIT = [
  'git',
  '-c',
  'user.name=nod test',
  '-c',
  'user.email=nod-test@example.invalid',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'commit.gpgsign=false',
]

const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = args.indexOf(name)
  return i === -1 ? null : (args[i + 1] ?? null)
}
const resumed = flag('--resume')
const sessionId = resumed ?? flag('--session-id') ?? 'missing'
const hooks: Hooks = JSON.parse(flag('--settings') ?? '{}').hooks ?? {}
const logPath = process.env.FAKE_AGENT_LOG
if (!logPath) throw new Error('FAKE_AGENT_LOG is not set')
const log = (entry: object): void => appendFileSync(logPath, `${JSON.stringify(entry)}\n`)

// Raw mode, so Escape arrives on its own and Enter ends a message.
const inputs: string[] = []
let typed = ''
let wake: () => void = () => {}
process.stdin.setRawMode(true)
process.stdin.on('data', (chunk: Buffer) => {
  // An arrow key arrives as an escape sequence; read it as one key, not Escape and text.
  for (const ch of chunk.toString().replaceAll(DOWN, '\0')) {
    if (ch === '\0') {
      inputs.push(DOWN)
    } else if (ch === ENTER) {
      inputs.push(typed === '' ? ENTER : typed)
      typed = ''
    } else if (ch === ESCAPE) {
      inputs.push(ESCAPE)
    } else {
      typed += ch
    }
  }
  wake()
})

async function nextInput(): Promise<string> {
  while (true) {
    const input = inputs.shift()
    if (input !== undefined) return input
    await new Promise<void>((resolve) => {
      wake = resolve
    })
  }
}

async function runHooks(event: string, payload: object): Promise<string> {
  let out = ''
  for (const group of hooks[event] ?? []) {
    for (const hook of group.hooks) {
      const proc = Bun.spawn(['sh', '-c', hook.command], {
        stdin: new Blob([JSON.stringify(payload)]),
        stdout: 'pipe',
        env: process.env,
      })
      out += await new Response(proc.stdout).text()
      await proc.exited
    }
  }
  return out
}

async function turn(message: string, continuing: boolean): Promise<void> {
  log({ event: 'turn', sessionId, message })
  const head = message.split('\n')[0] ?? ''
  let reply = 'NOD: done | did it'
  if (head.includes('need-permission')) {
    await runHooks('Notification', {
      session_id: sessionId,
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission',
    })
    // Like Claude Code: Escape denies and ends the turn on the spot, with no Stop hook.
    if ((await nextInput()) !== ENTER) {
      console.log('Interrupted · What should Claude do instead?')
      return
    }
    reply = 'NOD: done | allowed'
  } else if (head.includes('give-up')) {
    reply = 'NOD: failed | cannot do it'
  } else if (head.includes('silent')) {
    reply = 'Stopped without a report.'
  } else if (head.includes('ask-first')) {
    reply = 'Should I go ahead?\n**NOD: question | May I proceed?**'
  }
  // A worker that fixes things once told what is wrong, or once a human says yes.
  if (head.includes('failed:') || head.includes('Human decision: yes')) {
    writeFileSync('ok.txt', 'ok')
  }
  // In a repo, it commits once told its changes are not committed.
  if (head.includes('not committed')) {
    for (const args of [
      ['add', '-A'],
      ['commit', '-qm', 'fake work'],
    ]) {
      Bun.spawnSync([...GIT, ...args])
    }
  }
  // Like Claude Code, a continuation after a blocked stop usually has no report line.
  if (continuing) reply = 'Fixed it.'
  const out = await runHooks('Stop', {
    session_id: sessionId,
    last_assistant_message: reply,
    stop_hook_active: continuing,
  })
  const decision = out.trim() ? JSON.parse(out) : null
  if (decision?.decision === 'block') await turn(decision.reason, true)
}

// Like Claude Code in a repo it does not trust: the dialog starts on "No, exit", Down moves to
// "Yes", Enter picks, and the session starts only after "Yes".
async function trustDialog(): Promise<void> {
  let yes = false
  while (true) {
    const mark = (on: boolean): string => (on ? '❯' : ' ')
    process.stdout.write(
      `\x1b[2J\x1b[H ${mark(!yes)} No, exit\r\n ${mark(yes)} Yes, I trust this folder\r\n`,
    )
    const key = await nextInput()
    if (key === DOWN) yes = true
    else if (key === ENTER && yes) return
    else if (key === ENTER || key === ESCAPE) process.exit(0)
  }
}

log({
  event: 'launch',
  sessionId,
  resumed: resumed !== null,
  system: flag('--append-system-prompt'),
})
if (process.env.FAKE_AGENT_UNTRUSTED && resumed === null) await trustDialog()
await runHooks('SessionStart', { session_id: sessionId })
await turn(args.at(-1) ?? '', false)
while (true) await turn(await nextInput(), false)
