// Runs N identical tiny tasks all at once and reports wall time, peak memory, and failures.
// usage: bun scripts/bench.ts <n> [model]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../src/ledger'
import { runPool } from '../src/pool'
import { DEFAULT_SETTINGS, runTask } from '../src/runner'

const BRIEF =
  'Create a file named result.txt in the current directory containing exactly the text: ok'

const n = Number(process.argv[2])
if (!Number.isInteger(n) || n < 1) throw new Error('usage: bun scripts/bench.ts <n> [model]')
const model = process.argv[3] ?? 'haiku'

const home = mkdtempSync(join(tmpdir(), `nod-bench-${n}-`))
const ledger = new Ledger(home)
for (let i = 0; i < n; i++) ledger.add(BRIEF, null, null)

const samples: number[] = []
const sampler = setInterval(async () => samples.push(await treeRssMb(process.pid)), 1000)
const started = performance.now()
await runPool(
  () => ledger.ready(),
  (task) =>
    runTask(ledger, task, {
      home,
      permissionMode: 'acceptEdits',
      settings: DEFAULT_SETTINGS,
      model,
    }),
)
const wallSecs = (performance.now() - started) / 1000
clearInterval(sampler)

const tasks = ledger.list()
const attempts = tasks.flatMap((t) => ledger.attempts(t.id))
const durations = attempts.map(
  (a) => (Date.parse(a.finishedAt ?? '') - Date.parse(a.startedAt)) / 1000,
)
const byStatus = Object.groupBy(tasks, (t) => t.status)
console.log(
  JSON.stringify({
    n,
    model,
    wallSecs: Math.round(wallSecs),
    taskSecsAvg: Math.round(durations.reduce((a, b) => a + b, 0) / n),
    taskSecsMax: Math.round(Math.max(...durations)),
    peakRssMb: Math.round(Math.max(0, ...samples)),
    status: Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, v?.length])),
    costUsd: ledger.stats().costUsd,
    errors: [...new Set(tasks.flatMap((t) => (t.error ? [t.error.slice(0, 120)] : [])))],
    home,
  }),
)

// Sum of RSS over this process and all its descendants (claude, its MCP servers, shells).
async function treeRssMb(root: number): Promise<number> {
  const out = await new Response(Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,rss=']).stdout).text()
  const rows = out
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
  const children = new Map<number, number[]>()
  const rss = new Map<number, number>()
  for (const [pid = 0, ppid = 0, kb = 0] of rows) {
    rss.set(pid, kb)
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const pid = stack.pop() ?? root
    total += rss.get(pid) ?? 0
    stack.push(...(children.get(pid) ?? []))
  }
  return total / 1024
}
