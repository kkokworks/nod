import { afterAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const cli = resolve(import.meta.dir, 'cli.ts')

test('watch prints each decision once as it opens, and ends once no worker is running', async () => {
  const home = tmp.make('nod-watch-')
  const ledger = new Ledger(home)
  const ask = (question: string): number => {
    const taskId = ledger.add({
      brief: 'some task',
      repo: null,
      checkCmd: null,
      model: null,
      after: [],
    })
    ledger.setRunning(taskId, home)
    const attemptId = ledger.startAttempt({
      taskId,
      kind: 'start',
      decisionId: null,
      sessionId: 's',
      prompt: 'some task',
    })
    ledger.ask(taskId, attemptId, 'question', question)
    return taskId
  }
  ask('open before watching')
  const worker = ledger.add({
    brief: 'still working',
    repo: null,
    checkCmd: null,
    model: null,
    after: [],
  })
  ledger.setRunning(worker, home)
  const watch = Bun.spawn(['bun', cli, 'watch'], { env: { ...process.env, NOD_HOME: home } })

  await Bun.sleep(1500)
  ask('opened while watching')
  await Bun.sleep(1500)
  ledger.succeed(worker)

  expect(await watch.exited).toBe(0)
  const out = await new Response(watch.stdout).text()
  expect(out).not.toContain('open before watching')
  expect(out.split('opened while watching')).toHaveLength(2)
}, 15_000)
