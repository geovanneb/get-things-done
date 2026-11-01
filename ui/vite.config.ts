import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
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
