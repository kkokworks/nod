// Runs every ready task, refilling free slots as tasks finish. `ready` is re-read after each
// completion so work unblocked by a finished task starts right away.
export async function runPool<T extends { id: number }>(
  ready: () => T[],
  run: (task: T) => Promise<void>,
  max = Number.POSITIVE_INFINITY,
): Promise<void> {
  const running = new Map<number, Promise<number>>()
  while (true) {
    for (const task of ready()) {
      if (running.size >= max) break
      if (!running.has(task.id))
        running.set(
          task.id,
          run(task).then(() => task.id),
        )
    }
    if (running.size === 0) return
    running.delete(await Promise.race(running.values()))
  }
}
