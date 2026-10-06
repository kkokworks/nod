// Stands in for `claude -p` in tests. Words in the prompt pick the behaviour, and every call is
// logged to $FAKE_CLAUDE_LOG so tests can check which session was resumed.
import { appendFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = args.indexOf(name)
  return i === -1 ? null : (args[i + 1] ?? null)
}
const prompt = flag('-p') ?? ''
const resumed = flag('--resume')
const sessionId = resumed ?? flag('--session-id') ?? 'missing'

const log = process.env.FAKE_CLAUDE_LOG
if (!log) throw new Error('FAKE_CLAUDE_LOG is not set')
appendFileSync(log, `${JSON.stringify({ prompt, sessionId, resumed: resumed !== null })}\n`)

if (prompt.includes('crash')) process.exit(1)
if (prompt.includes('slow')) await Bun.sleep(1500)

let result = { outcome: 'succeeded', summary: 'done' }
if (prompt.includes('ask-first')) result = { outcome: 'needs_decision', summary: 'May I proceed?' }
if (prompt.includes('give-up')) result = { outcome: 'failed', summary: 'cannot do it' }
// A worker that fixes things once told what is wrong, or once a human says yes.
if (prompt.includes('check `') || prompt.includes('Human decision: yes')) {
  writeFileSync('ok.txt', 'ok')
}

console.log(
  JSON.stringify({
    is_error: false,
    session_id: sessionId,
    total_cost_usd: 0.01,
    structured_output: result,
  }),
)
