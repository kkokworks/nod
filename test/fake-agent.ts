// Stands in for interactive `claude` in tests. Each message is a turn: words in it pick the reply,
// then the hooks from --settings run as in Claude Code, and a hook that blocks the stop starts a
// continuation. Between turns it reads what is typed into its terminal. Every launch and turn is
// logged to $FAKE_AGENT_LOG.
import { appendFileSync, writeFileSync } from 'node:fs'

type Hooks = Record<string, { hooks: { command: string }[] }[]>

const ENTER = '\r'
const ESCAPE = '\x1b'

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
  for (const ch of chunk.toString()) {
    if (ch === ENTER) {
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
  let reply = 'NOD: done | did it'
  if (message.includes('need-permission')) {
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
  } else if (message.includes('give-up')) {
    reply = 'NOD: failed | cannot do it'
  } else if (message.includes('silent')) {
    reply = 'Stopped without a report.'
  } else if (message.includes('ask-first')) {
    reply = 'Should I go ahead?\n**NOD: question | May I proceed?**'
  }
  // A worker that fixes things once told what is wrong, or once a human says yes.
  if (message.includes('failed:') || message.includes('Human decision: yes')) {
    writeFileSync('ok.txt', 'ok')
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

log({ event: 'launch', sessionId, resumed: resumed !== null })
await turn(args.at(-1) ?? '', false)
while (true) await turn(await nextInput(), false)
