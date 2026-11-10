import { afterAll, expect, test } from 'bun:test'
import { existsSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { join, resolve } from 'node:path'
import { build, createServer, isRunnableDevEnvironment, resolveConfig } from 'vite'
import { tempDirs } from '../../test/tmp'

const root = `${import.meta.dir}/..`
const tmp = tempDirs()
afterAll(tmp.removeAll)

// The server's build moves the modules it bundles into dist/server/assets, where a worker's terminal
// ran `bun dist/server/assets/cli.ts run`, which is not there: the terminal ended at once.
test('the built server runs nod from src/cli.ts, not from beside its bundle', async () => {
  const config = { root, configFile: `${root}/vite.config.ts`, logLevel: 'silent' } as const
  const { plugins } = await resolveConfig(config, 'build', 'production', 'production')
  const dir = tmp.make('nod-ui-build-')
  const entry = join(dir, 'entry.ts')
  const settings = resolve(root, '../src/settings.ts')
  writeFileSync(entry, `export { CLI } from ${JSON.stringify(settings)}\n`)
  // As the server's build: its plugins, but TanStack Start's, which build the whole app.
  await build({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    plugins: plugins.filter((p) => p.name.startsWith('nod-')),
    build: { ssr: entry, outDir: join(dir, 'out') },
  })
  // Where the bundle's own packages (zod) are found, as ui/dist's are from the repo's.
  symlinkSync(resolve(root, '../node_modules'), join(dir, 'node_modules'))
  const { CLI } = await import(join(dir, 'out', 'entry.mjs'))
  expect(CLI).toBe(resolve(root, '../src/cli.ts'))
  expect(existsSync(CLI)).toBe(true)
}, 30_000)

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

// A task page's live terminal comes through the HTTP server of either (terminal.server.ts).
test("both the dev server and the built one take a worker's terminal", async () => {
  const config = { root, configFile: `${root}/vite.config.ts`, logLevel: 'silent' } as const
  const { plugins } = await resolveConfig(config, 'serve')
  const terminal = plugins.find((p) => p.name === 'nod-terminal')
  for (const hook of [terminal?.configureServer, terminal?.configurePreviewServer]) {
    const http = createHttpServer()
    if (typeof hook !== 'function') throw new Error('the terminal is not on this server')
    await hook.call({} as never, { httpServer: http } as never)
    expect(http.listenerCount('upgrade')).toBe(1)
  }
})

// As the server renders the page the window first shows, through the dev server's handler with no
// port open. The server's modules open the ledger at $NOD_HOME as they load.
async function rendered(check: (get: (path: string) => Promise<Response>) => Promise<void>) {
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
    await check((path) => entry.default.fetch(new Request(`http://127.0.0.1${path}`)))
  } finally {
    await vite.close()
    if (before === undefined) delete process.env.NOD_HOME
    else process.env.NOD_HOME = before
  }
}

test('the server renders a task, a todo or an address that is not there as 404, beside the sidebar', async () => {
  await rendered(async (get) => {
    for (const path of ['/tasks/999999', '/todos/999999', '/tasks/abc', '/nope']) {
      const res = await get(path)
      const html = await res.text()
      expect({ path, status: res.status }).toEqual({ path, status: 404 })
      expect(html).toContain('class="sidebar"')
      expect(html).toContain('>Not found</h1>')
    }
  })
}, 30_000)

test('the server sends /settings to Rules, and renders each page of Settings with the sidebar link lit', async () => {
  await rendered(async (get) => {
    const opened = await get('/settings')
    expect(opened.status).toBe(307)
    expect(opened.headers.get('location')).toBe('/settings/rules')
    for (const [path, shown] of [
      ['/settings/rules', 'No rules yet.'],
      ['/settings/orchestrators', 'No orchestrator sessions yet.'],
      ['/settings/relays', 'No relay sessions yet.'],
    ] as const) {
      const res = await get(path)
      const html = await res.text()
      expect({ path, status: res.status }).toEqual({ path, status: 200 })
      expect(html).toContain('>Settings</h1>')
      expect(html.replaceAll('<!-- -->', '')).toContain(shown)
      expect(html).toContain('class="side-item active" href="/settings"')
    }
  })
}, 30_000)
