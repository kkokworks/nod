// Runs every ready task, refilling free slots. `ready` is re-read when a task finishes, so work
// unblocked by it starts right away, and every `pollMs`, so tasks added or answered while others
// run do not wait for them.
export async function runPool<T extends { id: number }>(
  ready: () => T[],
  run: (task: T) => Promise<void>,
  max = Number.POSITIVE_INFINITY,
  pollMs = 1000,
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
    const finished = await Promise.race([...running.values(), Bun.sleep(pollMs)])
    if (typeof finished === 'number') running.delete(finished)
  }
}
