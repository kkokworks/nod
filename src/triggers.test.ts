import { afterAll, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'
import { addTrigger, nextRun, parseItems } from './triggers'

// Only what runs without workers; tick starts tasks, so it is tested with the fake agent in
// worker.test.ts.
const tmp = tempDirs()
afterAll(tmp.removeAll)

test('a source line is one item, keyed by what comes before a tab', () => {
  expect(parseItems('12\tFix login\n\nplain line\n')).toEqual([
    { key: '12', text: 'Fix login' },
    { key: 'plain line', text: 'plain line' },
  ])
})

test('schedules are read in local time', () => {
  const at = (day: number, hour: number): Date => new Date(2026, 9, day, hour, 0)
  expect(nextRun('0 9 * * *', at(6, 8))).toEqual(at(6, 9))
  expect(nextRun('0 9 * * *', at(6, 10))).toEqual(at(7, 9))
  expect(nextRun('0 9 * * MON-FRI', at(9, 10))).toEqual(at(12, 9)) // Friday to Monday
  expect(() => nextRun('every day', at(6, 8))).toThrow('Invalid cron expression')
})

test('adding a trigger with a source records what it lists now, and a failing source adds none', async () => {
  const home = tmp.make('nod-triggers-')
  const ledger = new Ledger(home)
  const items = join(home, 'items.txt')
  writeFileSync(items, 'a\tfirst\nb\tsecond\n')
  const base = { cron: '*/5 * * * *', brief: 'look', repo: null, checkCmd: null, model: null }
  const added = await addTrigger(ledger, home, { ...base, source: `cat ${JSON.stringify(items)}` })
  expect(added.seen).toBe(2)
  expect(ledger.addItemTask(ledger.trigger(added.id), 'a', 'look')).toBeNull()

  await expect(addTrigger(ledger, home, { ...base, source: 'exit 3' })).rejects.toThrow('exited 3')
  expect(ledger.triggers().map((t) => t.id)).toEqual([added.id])
})
