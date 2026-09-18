import { execFileSync } from 'node:child_process'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const machineConfigScript = path.resolve(__dirname, '../../shared/machine-config.ts')
let hubPort: string
try {
  hubPort = execFileSync('bun', ['--no-env-file', machineConfigScript, 'get', 'hub.port'], {
    encoding: 'utf8',
  }).trim()
} catch (error) {
  const stderr =
    error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : ''
  if (stderr) throw new Error(stderr)
  throw error
}

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
