import { expect, test } from 'bun:test'
import { runPool } from './pool'

async function measure(max?: number): Promise<{ allDone: boolean; peak: number; runs: number }> {
  const tasks = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, done: false }))
  let active = 0
  let peak = 0
  let runs = 0
  // `ready` keeps returning in-flight tasks, so this also checks a task never starts twice.
  await runPool(
    () => tasks.filter((t) => !t.done),
    async (t) => {
      runs++
      active++
      peak = Math.max(peak, active)
      await Bun.sleep(5)
      active--
      t.done = true
    },
    max,
  )
  return { allDone: tasks.every((t) => t.done), peak, runs }
}

test('runs every task once, all at once by default', async () => {
  expect(await measure()).toEqual({ allDone: true, peak: 7, runs: 7 })
})

test('never exceeds max', async () => {
  expect(await measure(3)).toEqual({ allDone: true, peak: 3, runs: 7 })
})

test('picks up tasks that become ready while others run', async () => {
  const order: number[] = []
  const blockedUntilOneDone = { id: 2, unblocked: false, done: false }
  const first = { id: 1, unblocked: true, done: false }
  const tasks = [first, blockedUntilOneDone]
  await runPool(
    () => tasks.filter((t) => t.unblocked && !t.done),
    async (t) => {
      await Bun.sleep(5)
      order.push(t.id)
      t.done = true
      if (t.id === 1) blockedUntilOneDone.unblocked = true
    },
  )
  expect(order).toEqual([1, 2])
})
