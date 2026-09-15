import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const hubPort = process.env.HUB_PORT ?? '7778'

export default defineConfig({
  base: '/',
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    proxy: Object.fromEntries(
      ['/trpc', '/api'].map((route) => [
        route,
        {
          target: `http://127.0.0.1:${hubPort}`,
          changeOrigin: true,
        },
      ]),
    ),
  },
})
