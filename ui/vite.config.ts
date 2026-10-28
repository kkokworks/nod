import type { Server } from 'node:http'
import { join } from 'node:path'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// A task page's live terminal (src/terminal.server.ts), on the HTTP server of either. Loaded as the
// server starts, not with this file: the terminal reaches the ledger's code, which needs Bun, and
// reading this file must not (where `bun --bun` cannot put itself in for node, Node reads it).
const terminal = async (http: Server): Promise<void> => {
  const path = join(import.meta.dirname, 'src/terminal.server.ts')
  const served: typeof import('./src/terminal.server') = await import(/* @vite-ignore */ path)
  served.serveTerminals(http)
}
const terminalPlugin: Plugin = {
  name: 'nod-terminal',
  // None in middleware mode, where a test drives the server itself.
  configureServer: ({ httpServer }) =>
    httpServer === null ? undefined : terminal(httpServer as Server),
  configurePreviewServer: ({ httpServer }) => terminal(httpServer as Server),
}

export default defineConfig({
  plugins: [
    tanstackStart({ router: { quoteStyle: 'single', semicolons: false } }),
    viteReact(),
    terminalPlugin,
  ],
  // Vite's default lets any localhost origin read the responses, and the pages show workers'
  // reports and screens. The CSRF middleware guards only the server functions.
  server: { cors: false },
  preview: { cors: false },
})
