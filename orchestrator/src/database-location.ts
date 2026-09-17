import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { FROZEN_STATE_NAMES } from '../../shared/brand.ts'
import { inspectionGitEnv } from '../../shared/git.ts'
import {
  concernStateDirectory,
  legacyStoreRefusal,
  type StateEnvironment,
} from '../../shared/state-directory.ts'

export type DatabaseResolutionMethod = 'ORCH_DB' | 'git-common-dir' | 'git-pointer' | 'state-root'

export type DatabaseResolution = {
  path: string
  method: DatabaseResolutionMethod
  tried: string[]
  registeredPath: string | null
  repositoryRoot: string | null
  repositoryCandidate: string | null
  repositoryCandidateExisted: boolean
  initializable: boolean
  linkedWorktreeBinary: boolean
  /** The store beside the binary's main checkout, whatever ORCH_DB names. */
  mainStorePath: string | null
}

export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

type RepositoryRoot = {
  root: string
  method: 'git-common-dir' | 'git-pointer'
  linked: boolean
}

function repositoryRootFromGit(cwd: string): RepositoryRoot | null {
  try {
    const git = Bun.spawnSync(
      ['git', 'rev-parse', '--is-bare-repository', '--git-dir', '--git-common-dir'],
      {
        cwd,
        env: inspectionGitEnv(),
        stdout: 'pipe',
        stderr: 'ignore',
      },
    )
    if (git.exitCode !== 0) return null
    const [bare, gitDirOutput, commonOutput] = git.stdout.toString().trim().split('\n')
    if (!gitDirOutput || !commonOutput || (bare !== 'true' && bare !== 'false')) return null
    const gitDir = resolve(cwd, gitDirOutput)
    const common = resolve(cwd, commonOutput)
    return {
      root: bare === 'true' ? common : dirname(common),
      method: 'git-common-dir',
      linked: gitDir !== common,
    }
  } catch {
    return null
  }
}

/**
 * Git may be unable to traverse a linked worktree's common directory even
 * though the worktree pointer remains readable. The pointer has one safe
 * shape: <main>/.git/worktrees/<name>.
 */
function repositoryRootFromDotGit(cwd: string): RepositoryRoot | null {
  let current = resolve(cwd)
  while (true) {
    const dotGit = join(current, '.git')
    if (existsSync(dotGit)) {
      try {
        if (statSync(dotGit).isDirectory()) {
          return { root: current, method: 'git-pointer', linked: false }
        }
        const match = readFileSync(dotGit, 'utf8')
          .trim()
          .match(/^gitdir: (.+)$/)
        if (!match) throw new Error(`invalid git worktree pointer: ${dotGit}`)
        const gitDir = resolve(current, match[1]!)
        const worktrees = dirname(gitDir)
        const common = dirname(worktrees)
        if (
          basename(worktrees) !== 'worktrees' ||
          basename(common) !== '.git' ||
          dirname(gitDir) === gitDir
        ) {
          throw new Error(`invalid git worktree pointer: ${dotGit}`)
        }
        return { root: dirname(common), method: 'git-pointer', linked: true }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('invalid git worktree pointer:'))
          throw error
        throw new Error(`cannot read git repository marker: ${dotGit}: ${String(error)}`)
      }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function resolveDatabase(
  cwd = process.cwd(),
  env: StateEnvironment = process.env as StateEnvironment,
  binaryRoot = ROOT,
): DatabaseResolution {
  const binaryRepository = repositoryRootFromGit(binaryRoot) ?? repositoryRootFromDotGit(binaryRoot)
  const mainStorePath = join(
    concernStateDirectory('orchestrator', env),
    FROZEN_STATE_NAMES.orchestratorDatabase,
  )
  if (env.ORCH_DB) {
    return {
      path: resolve(env.ORCH_DB),
      method: 'ORCH_DB',
      tried: [resolve(env.ORCH_DB)],
      registeredPath: null,
      repositoryRoot: null,
      repositoryCandidate: null,
      repositoryCandidateExisted: false,
      initializable: true,
      linkedWorktreeBinary: Boolean(binaryRepository?.linked),
      mainStorePath,
    }
  }
  const repository = repositoryRootFromGit(cwd) ?? repositoryRootFromDotGit(cwd)
  return {
    path: mainStorePath,
    method: 'state-root',
    tried: [mainStorePath],
    registeredPath: null,
    repositoryRoot: repository?.root ?? null,
    repositoryCandidate: null,
    repositoryCandidateExisted: false,
    // Location is per-user, but binary identity still owns initialization.
    initializable: Boolean(binaryRepository && !binaryRepository.linked),
    linkedWorktreeBinary: Boolean(binaryRepository?.linked),
    mainStorePath,
  }
}

/** A test process never falls back to the live orchestrator store. */
export function decideOrchestratorDatabasePath(
  isTestProcess: boolean,
  method: DatabaseResolutionMethod,
  resolvedPath: string,
): string {
  if (isTestProcess && method !== 'ORCH_DB') {
    throw new Error(
      `test process refuses orchestrator database: ORCH_DB resolved <unset>; live store is ${resolvedPath}\n` +
        'invariant: A test suite never falls back to the live orchestrator database.\n' +
        'cleared by: set ORCH_DB to a scratch store before importing orchestrator/src/db.ts',
    )
  }
  return resolvedPath
}

export const DATABASE_RESOLUTION = resolveDatabase()
export const DB_PATH = decideOrchestratorDatabasePath(
  process.env.NODE_ENV === 'test',
  DATABASE_RESOLUTION.method,
  DATABASE_RESOLUTION.path,
)

export function missingDatabaseMessage(path = DB_PATH): string {
  return `orchestrator database does not exist: ${path}\nrun orch init-db to create it`
}

export function legacyDatabaseRefusal(
  resolution: DatabaseResolution = DATABASE_RESOLUTION,
  env: StateEnvironment = process.env as StateEnvironment,
): string | null {
  if (resolution.method === 'ORCH_DB' || !resolution.mainStorePath) return null
  const binaryRepository = repositoryRootFromGit(ROOT) ?? repositoryRootFromDotGit(ROOT)
  if (!binaryRepository) return null
  const legacyStore = join(
    binaryRepository.root,
    'orchestrator',
    FROZEN_STATE_NAMES.orchestratorDatabase,
  )
  return legacyStoreRefusal(existsSync(resolution.path), existsSync(legacyStore), {
    legacyStore,
    destinationStore: resolution.path,
    legacyRuns: join(binaryRepository.root, 'orchestrator', FROZEN_STATE_NAMES.runsDirectory),
    destinationRuns: resolveRunsDirectory(resolution, env),
  })
}

export function resolveRunsDirectory(
  resolution: Pick<DatabaseResolution, 'path'> = DATABASE_RESOLUTION,
  env: StateEnvironment = process.env as StateEnvironment,
): string {
  return env.ORCH_RUNS
    ? resolve(env.ORCH_RUNS)
    : join(dirname(resolution.path), FROZEN_STATE_NAMES.runsDirectory)
}
