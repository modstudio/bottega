import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** Drop repository routing inherited from a worker before invoking git elsewhere. */
export function scrubbedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const variable of Object.keys(env)) {
    if (variable === 'GIT_DIR' || variable === 'GIT_WORK_TREE' ||
        variable === 'GIT_OBJECT_DIRECTORY' || variable === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ||
        variable === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(variable) ||
        variable === 'ORCH_GUARDED_GIT_COMMON_DIR' || variable === 'ORCH_ALLOWED_GIT_REF') {
      delete env[variable]
    }
  }
  return env
}

/** Resolve the main checkout belonging to a checkout or linked worktree. */
export function mainCheckoutOf(cwd: string, env?: Record<string, string | undefined>): string | null {
  if (!existsSync(cwd)) return null
  const result = Bun.spawnSync(
    ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, env: env ?? scrubbedGitEnv(),
      stdout: 'pipe', stderr: 'ignore' },
  )
  if (result.exitCode !== 0) return null
  const common = result.stdout.toString().trim()
  return common ? dirname(common) : null
}
