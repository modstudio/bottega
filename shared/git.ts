import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** Resolve the main checkout belonging to a checkout or linked worktree. */
export function mainCheckoutOf(cwd: string, env?: Record<string, string>): string | null {
  if (!existsSync(cwd)) return null
  const result = Bun.spawnSync(
    ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, env: env ? { ...globalThis.process.env, ...env } : globalThis.process.env,
      stdout: 'pipe', stderr: 'ignore' },
  )
  if (result.exitCode !== 0) return null
  const common = result.stdout.toString().trim()
  return common ? dirname(common) : null
}
