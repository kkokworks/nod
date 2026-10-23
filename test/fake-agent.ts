// Stands in for interactive `claude` in tests. Each message is a turn: words in its first line pick
// the reply, so context nod adds below cannot, then the hooks from --settings run as in Claude
// Code, and a hook that blocks the stop starts a continuation. Between turns it reads what is typed
// into its terminal. Started with no message, it waits for one. Like Claude Code, it keeps a
// transcript in $CLAUDE_CONFIG_DIR (only when that is set, so a test never writes to the real one).
// nod gives a worker a fixed environment, so the fake takes its switches from files in $NOD_HOME:
// with `fake-untrusted`, a new session first shows the trust dialog; with `fake-exit`, it exits as
// it starts, as Claude Code does without a login. Every launch, with its account and the names in
// its environment, and every turn is logged to $NOD_HOME/agent.log.
import { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
// The options of claude nod passes a value with.
const VALUED = new Set([
  '--resume',
  '--session-id',
  '--settings',
  '--append-system-prompt',
  '--model',
  '--permission-mode',
])

const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = args.indexOf(name)
  return i === -1 ? null : (args[i + 1] ?? null)
}
const resumed = flag('--resume')
const sessionId = resumed ?? flag('--session-id') ?? 'missing'
const hooks: Hooks = JSON.parse(flag('--settings') ?? '{}').hooks ?? {}
const home = process.env.NOD_HOME
if (!home) throw new Error('NOD_HOME is not set')
const log = (entry: object): void =>
  appendFileSync(join(home, 'agent.log'), `${JSON.stringify(entry)}\n`)
const prompt = args.find((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1] ?? '')) ?? null

// Like `claude -p`, which nod runs as the reviewer: the prompt comes on stdin and the reply is
// printed once. A brief with `review-strict` fails until ok.txt exists; `review-mute` gives no
// verdict.
if (args.includes('-p')) {
  const stdin = await Bun.stdin.text()
  log({ event: 'review', sessionId, message: stdin })
  let reply = 'NOD: done | looks right'
  if (stdin.includes('review-strict') && !existsSync('ok.txt')) {
    reply = 'ok.txt is missing.\nNOD: failed | ok.txt is missing'
  } else if (stdin.includes('review-mute')) {
    reply = 'Looks fine.'
  }
  console.log(reply)
  process.exit(0)
}

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

// Where Claude Code keeps a session's transcript (sessionFolder in worker.ts).
function keepTranscript(): void {
  const config = process.env.CLAUDE_CONFIG_DIR
  if (!config) return
  const folder = join(config, 'projects', realpathSync(process.cwd()).replace(/[/.]/g, '-'))
  mkdirSync(folder, { recursive: true })
  appendFileSync(join(folder, `${sessionId}.jsonl`), '{}\n')
}

async function turn(message: string, continuing: boolean): Promise<void> {
  log({ event: 'turn', sessionId, message })
  keepTranscript()
  const head = message.split('\n')[0] ?? ''
  let reply = 'NOD: done | did it'
  if (head.includes('hang')) {
    // A turn that goes on until something ends Claude Code.
    await new Promise(() => {})
  } else if (head.includes('need-permission')) {
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
  } else if (head.includes('capture')) {
    reply = [
      'NOD: in {"title": "Ask Kim again", "source": "chat", "key": "m1"}',
      '`NOD: in {"title": "Book the room", "link": "https://example.com/r"}`',
      ...(head.includes('capture-bad') ? ['NOD: in {"title": " "}'] : []),
      'NOD: done | captured',
    ].join('\n')
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
  // Told a `NOD: in` line was wrong, it reports again with only the good one.
  if (head.includes('NOD: in')) {
    reply = 'NOD: in {"title": "Ask Kim again", "source": "chat", "key": "m1"}\nNOD: done | fixed'
  }
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
  prompt,
  system: flag('--append-system-prompt'),
  config: process.env.CLAUDE_CONFIG_DIR ?? null,
  env: Object.keys(process.env),
})
if (existsSync(join(home, 'fake-exit'))) {
  console.log('Not logged in · Please run /login')
  process.exit(1)
}
if (existsSync(join(home, 'fake-untrusted')) && resumed === null) await trustDialog()
await runHooks('SessionStart', { session_id: sessionId })
if (prompt !== null) await turn(prompt, false)
while (true) await turn(await nextInput(), false)
