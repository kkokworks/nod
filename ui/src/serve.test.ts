import { expect, test } from 'bun:test'
import { resolveConfig } from 'vite'

// Vite answers a CORS request from any localhost or 127.0.0.1 origin by default, and the CSRF
// middleware guards only the server functions, so another page on this computer could read the
// task pages. Both servers turn CORS off.
test('neither the dev server nor the built one lets another origin read the pages', async () => {
  const root = `${import.meta.dir}/..`
  const config = { root, configFile: `${root}/vite.config.ts`, logLevel: 'silent' } as const
  const dev = await resolveConfig(config, 'serve')
  const built = await resolveConfig(config, 'serve', 'production', 'production', true)
  expect(dev.server.cors).toBe(false)
  expect(built.preview.cors).toBe(false)
})
