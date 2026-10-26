// Stands in for interactive `claude` in tests. Each message is a turn: words in its first line pick
// the reply, so context nod adds below cannot, and the hooks from --settings run as in Claude
// Code, UserPromptSubmit before it and Stop after, and a hook that blocks the stop starts a
// continuation. Between turns it reads what is typed
// into its terminal. Started with no message, it waits for one. Like Claude Code, it keeps a
// transcript in $CLAUDE_CONFIG_DIR (only when that is set, so a test never writes to the real one),
// refuses a new session the ID of one it has a transcript of, and an option it does not know.
// nod gives a worker a fixed environment, so the fake takes its switches from files in $NOD_HOME:
// with `fake-untrusted`, a new session first shows the trust dialog, and with `fake-untrusted-again`
// a resumed one does, as Claude Code asks about a repo once per account; with `fake-exit`, it exits
// as it starts, as Claude Code does without a login; with `fake-slow-start`, it never gets past its
// start, as Claude Code waiting on a first-run screen. Every launch, with its account and the names
// in its environment, every turn, and what a turn takes in while it runs is logged to
// $NOD_HOME/agent.log.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { projectFolder } from './projects'

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
// Like Claude Code (commander): before `--`, an argument that starts with `-` is an option; after
// it, the prompt.
const dashes = args.indexOf('--')
const options = dashes === -1 ? args : args.slice(0, dashes)
const flag = (name: string): string | null => {
  const i = options.indexOf(name)
  return i === -1 ? null : (options[i + 1] ?? null)
}
const resumed = flag('--resume')
const sessionId = resumed ?? flag('--session-id') ?? 'missing'
const hooks: Hooks = JSON.parse(flag('--settings') ?? '{}').hooks ?? {}
const home = process.env.NOD_HOME
if (!home) throw new Error('NOD_HOME is not set')
const log = (entry: object): void =>
  appendFileSync(join(home, 'agent.log'), `${JSON.stringify(entry)}\n`)
const prompt =
  dashes === -1
    ? (options.find((a, i) => !a.startsWith('-') && !VALUED.has(options[i - 1] ?? '')) ?? null)
    : (args[dashes + 1] ?? null)

// Like `claude -p`, which nod runs as the reviewer: the prompt comes on stdin and the reply is
// printed once. A brief with `review-strict` fails until ok.txt exists; `review-mute` gives no
// verdict; `review-slow` takes a while. Like Claude Code under a user's UserPromptSubmit hook that
// screens for personal data, a brief with a value shaped like a national ID number is blocked
// before any model runs: it prints why, then the whole brief, and exits 0 (2.1.310). It logs the
// diff file its brief names as it reads it then, and the folder it may read (--add-dir), as given
// and with its links resolved.
if (args.includes('-p')) {
  const stdin = await Bun.stdin.text()
  const saved = /`([^`]+\.diff)`/.exec(stdin)?.[1]
  log({
    event: 'review',
    sessionId,
    message: stdin,
    diff: saved !== undefined && existsSync(saved) ? readFileSync(saved, 'utf8') : null,
    addDir: flag('--add-dir'),
    addDirReal: existsSync(flag('--add-dir') ?? '') ? realpathSync(flag('--add-dir') ?? '') : null,
  })
  if (/\d{6}-\d{7}/.test(stdin)) {
    // Claude Code names the hook by its command, which may be a long inline script.
    const hook = `node -e '${'x'.repeat(5000)}' screen-pii`
    console.log(
      `UserPromptSubmit operation blocked by hook:\n[${hook}]: looks like a national ID number\n\n\nOriginal prompt: ${stdin}`,
    )
    process.exit(0)
  }
  if (stdin.includes('review-slow')) await Bun.sleep(3000)
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

// Where Claude Code keeps this session's transcript; null without a config dir.
function transcript(): string | null {
  const config = process.env.CLAUDE_CONFIG_DIR
  return config ? join(projectFolder(config, process.cwd()), `${sessionId}.jsonl`) : null
}

function keepTranscript(): void {
  const file = transcript()
  if (file === null) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, '{}\n')
}

async function turn(message: string, continuing: boolean): Promise<void> {
  // Like Claude Code, for each message it takes in, before the turn; not for a blocked stop's
  // continuation. What the hook prints would go into the conversation.
  if (!continuing) {
    const said = await runHooks('UserPromptSubmit', { session_id: sessionId, prompt: message })
    if (said !== '') log({ event: 'prompt-hook-said', sessionId, message: said })
  }
  log({ event: 'turn', sessionId, message })
  keepTranscript()
  const head = message.split('\n')[0] ?? ''
  let reply = 'NOD: done | did it'
  if (head.startsWith('hang')) {
    // A turn that goes on until something ends Claude Code.
    await new Promise(() => {})
  } else if (head.startsWith('stall')) {
    // Like Claude Code at a usage limit: the turn ends with StopFailure in place of Stop.
    await runHooks('StopFailure', { session_id: sessionId, error: 'rate_limit' })
    return
  } else if (head.startsWith('slow')) {
    // A turn that takes a while and, like Claude Code, takes in what is typed meanwhile.
    await Bun.sleep(3000)
    for (const input of inputs.splice(0)) log({ event: 'heard', sessionId, message: input })
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
  } else if (head.startsWith('tell #')) {
    // Tells the task it names the rest of the line, as `NOD: tell #<task> <message>`.
    reply = `NOD: ${head}\nNOD: done | told`
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
    Bun.spawnSync([...GIT, 'add', '-A'])
    Bun.spawnSync([...GIT, 'commit', '-qm', 'fake work'])
  }
  // Like Claude Code, a continuation after a blocked stop usually has no report line.
  if (continuing) reply = 'Fixed it.'
  // Told a `NOD: in` line was wrong, it reports again with only the good one.
  if (head.includes('NOD: in')) {
    reply = 'NOD: in {"title": "Ask Kim again", "source": "chat", "key": "m1"}\nNOD: done | fixed'
  }
  // Another task's worker asks it to answer (`ping-back` below nod's header): it tells that one back.
  const peer = /^Message from the worker of nod task #(\d+)/.exec(head)
  if (peer !== null && message.includes('ping-back')) {
    reply = `NOD: tell #${peer[1]} fixed it\nNOD: done | fixed`
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
// "Yes", Enter picks, also after text pasted into it, and the session starts only after "Yes".
async function trustDialog(): Promise<void> {
  let yes = false
  while (true) {
    const mark = (on: boolean): string => (on ? '❯' : ' ')
    process.stdout.write(
      `\x1b[2J\x1b[H ${mark(!yes)} No, exit\r\n ${mark(yes)} Yes, I trust this folder\r\n`,
    )
    const key = await nextInput()
    if (key === DOWN) yes = true
    else if (key !== ESCAPE && yes) return
    else process.exit(0)
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
const unknown = options.find(
  (a, i) => a.startsWith('-') && !VALUED.has(a) && !VALUED.has(options[i - 1] ?? ''),
)
if (unknown !== undefined) {
  console.log(`error: unknown option '${unknown}'`)
  process.exit(1)
}
// Like Claude Code, a new session cannot take the ID of one it keeps a transcript of.
const kept = transcript()
if (flag('--session-id') !== null && kept !== null && existsSync(kept)) {
  console.log(`Error: Session ID ${sessionId} is already in use.`)
  process.exit(1)
}
if (existsSync(join(home, 'fake-exit'))) {
  console.log('Not logged in · Please run /login')
  process.exit(1)
}
if (existsSync(join(home, 'fake-slow-start'))) await new Promise(() => {})
if (existsSync(join(home, resumed === null ? 'fake-untrusted' : 'fake-untrusted-again'))) {
  await trustDialog()
}
await runHooks('SessionStart', { session_id: sessionId })
if (prompt !== null) await turn(prompt, false)
while (true) await turn(await nextInput(), false)
