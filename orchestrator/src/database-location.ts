import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type DatabaseResolutionMethod = 'ORCH_DB' | 'git-common-dir' | 'binary-relative'

export type DatabaseResolution = {
  path: string
  method: DatabaseResolutionMethod
  tried: string[]
  registeredPath: string | null
}

export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
function commonDirectoryDatabase(cwd: string): string | null {
  try {
    const git = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], {
      cwd, stdout: 'pipe', stderr: 'ignore',
    })
    if (git.exitCode !== 0) return null
    const common = resolve(cwd, git.stdout.toString().trim())
    return join(dirname(common), 'orchestrator', 'orch.db')
  } catch {
    return null
  }
}

export function resolveDatabase(
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  binaryRoot = ROOT,
): DatabaseResolution {
  if (env.ORCH_DB) {
    return { path: resolve(env.ORCH_DB), method: 'ORCH_DB', tried: [resolve(env.ORCH_DB)], registeredPath: null }
  }

  const binaryRelative = join(binaryRoot, 'orch.db')
  const tried: string[] = []
  const common = commonDirectoryDatabase(cwd)
  if (common) {
    tried.push(common)
    if (existsSync(common)) {
      return { path: common, method: 'git-common-dir', tried, registeredPath: null }
    }
  }

  tried.push(binaryRelative)
  if (!binaryRoot.includes('/.claude/worktrees/')) {
    return { path: binaryRelative, method: 'binary-relative', tried, registeredPath: null }
  }

  throw new Error(
    `orchestrator database could not be resolved; tried:\n${tried.map((path) => `  ${path}`).join('\n')}\n` +
    `run orch init-db from the main checkout to create it`,
  )
}

export const DATABASE_RESOLUTION = resolveDatabase()
export const DB_PATH = DATABASE_RESOLUTION.path

export function missingDatabaseMessage(path = DB_PATH): string {
  return `orchestrator database does not exist: ${path}\nrun orch init-db to create it`
}

export function resolveRunsDirectory(
  resolution: Pick<DatabaseResolution, 'path'> = DATABASE_RESOLUTION,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return env.ORCH_RUNS ? resolve(env.ORCH_RUNS) : join(dirname(resolution.path), 'runs')
}
