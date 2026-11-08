import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { startBounded } from '../../shared/bounded-process.ts'

const machineConfigScript = path.resolve(__dirname, '../../shared/machine-config.ts')
export default defineConfig(async () => {
  let hubPort: string
  try {
    const result = await startBounded(
      ['bun', '--no-env-file', machineConfigScript, 'get', 'hub.port'],
      { budget: 'self-cli' },
    )
    if (result.exitCode !== 0) throw new Error(result.stderr)
    hubPort = result.stdout.trim()
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : ''
    if (stderr) throw new Error(stderr)
    throw error
  }

  return {
    base: '/',
    plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        // codemirror-lang-mermaid imports @lezer/common without declaring it.
        '@lezer/common': path.resolve(__dirname, '../views/node_modules/@lezer/common'),
      },
    },
    server: {
      proxy: {
        ...Object.fromEntries(
          ['/trpc', '/api'].map((route) => [
            route,
            {
              target: `http://127.0.0.1:${hubPort}`,
              changeOrigin: true,
            },
          ]),
        ),
        // The login link signs the dev page in; its redirect is built from the Host it sees.
        '/login': { target: `http://127.0.0.1:${hubPort}` },
      },
    },
  }
})
