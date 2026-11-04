import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'

// The app version this page is built from: a page can tell when the dashboard it talks to runs another one (#284).
const appVersion = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8')).version as string

export default defineConfig({
  plugins: [react()],
  define: {
    __GTD_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // GTD_API_URL points the dev server at another API, such as a demo workspace on another port.
        target: process.env.GTD_API_URL ?? 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
})
