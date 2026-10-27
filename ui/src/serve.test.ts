import { afterAll, expect, test } from 'bun:test'
import { createServer, isRunnableDevEnvironment, resolveConfig } from 'vite'
import { tempDirs } from '../../test/tmp'

const root = `${import.meta.dir}/..`
const tmp = tempDirs()
afterAll(tmp.removeAll)

// Vite answers a CORS request from any localhost or 127.0.0.1 origin by default, and the CSRF
// middleware guards only the server functions, so another page on this computer could read the
// task pages. Both servers turn CORS off.
test('neither the dev server nor the built one lets another origin read the pages', async () => {
  const config = { root, configFile: `${root}/vite.config.ts`, logLevel: 'silent' } as const
  const dev = await resolveConfig(config, 'serve')
  const built = await resolveConfig(config, 'serve', 'production', 'production', true)
  expect(dev.server.cors).toBe(false)
  expect(built.preview.cors).toBe(false)
})

// As the server renders the page the window first shows, through the dev server's handler with no
// port open. The server's modules open the ledger at $NOD_HOME as they load.
test('the server renders a task, a todo or an address that is not there as 404, beside the sidebar', async () => {
  const before = process.env.NOD_HOME
  process.env.NOD_HOME = tmp.make('nod-ui-serve-')
  const vite = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: 'silent',
  })
  try {
    const ssr = vite.environments.ssr
    if (!isRunnableDevEnvironment(ssr)) throw new Error('the SSR environment does not run here')
    const entry = await ssr.runner.import('@tanstack/react-start/server-entry')
    for (const path of ['/tasks/999999', '/todos/999999', '/tasks/abc', '/nope']) {
      const res: Response = await entry.default.fetch(new Request(`http://127.0.0.1${path}`))
      const html = await res.text()
      expect({ path, status: res.status }).toEqual({ path, status: 404 })
      expect(html).toContain('class="sidebar"')
      expect(html).toContain('>Not found</h1>')
    }
  } finally {
    await vite.close()
    if (before === undefined) delete process.env.NOD_HOME
    else process.env.NOD_HOME = before
  }
}, 30_000)
