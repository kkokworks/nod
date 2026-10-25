import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tanstackStart({ router: { quoteStyle: 'single', semicolons: false } }), viteReact()],
  // Vite's default lets any localhost origin read the responses, and the pages show workers'
  // reports and screens. The CSRF middleware guards only the server functions.
  server: { cors: false },
  preview: { cors: false },
})
