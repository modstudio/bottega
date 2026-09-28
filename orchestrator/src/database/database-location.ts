import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FROZEN_STATE_NAMES, PLATFORM_NAME } from '../../../shared/brand.ts'
import { embeddedDistributionManifest } from '../../../shared/embedded-assets.ts'
import { borrowedCheckoutOf, inspectionGitEnv } from '../../../shared/git.ts'
import { isAuthorizedPlatformInstallation } from '../../../shared/install-root.ts'
import {
  legacyStoreRefusal,
  resolveOrchestratorDatabase,
  resolveRunsDirectory,
  resolveStatePaths,
  type StateEnvironment,
} from '../../../shared/state-directory.ts'

export type DatabaseResolutionMethod = 'ORCH_DB' | 'state-root'

export type DatabaseResolution = {
  path: string
  method: DatabaseResolutionMethod
  tried: string[]
  registeredPath: string | null
  repositoryRoot: string | null
  initializable: boolean
  linkedWorktreeBinary: boolean
  /** The default per-user store, or the explicit store when no state root can be resolved. */
  mainStorePath: string
}

export const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')

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
    const borrowed = bare === 'false' ? borrowedCheckoutOf(cwd) : null
    return {
      root: borrowed ?? (bare === 'true' ? common : dirname(common)),
      method: 'git-common-dir',
      linked: gitDir !== common || borrowed !== null,
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
          const borrowed = borrowedCheckoutOf(current)
          return {
            root: borrowed ?? current,
            method: 'git-pointer',
            linked: borrowed !== null,
          }
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
  const binaryRepository = embeddedDistributionManifest()
    ? null
    : (repositoryRootFromGit(binaryRoot) ?? repositoryRootFromDotGit(binaryRoot))
  const path = resolveOrchestratorDatabase(env)
  if (env.ORCH_DB) {
    // ORCH_DB is independently sufficient. When HOME is available, retaining
    // the default path lets linked-worktree binaries still recognize an
    // override that points back at the shared store.
    let mainStorePath = path
    try {
      mainStorePath = resolveStatePaths(env).orchestratorDatabase
    } catch {}
    return {
      path,
      method: 'ORCH_DB',
      tried: [path],
      registeredPath: null,
      repositoryRoot: null,
      initializable: true,
      linkedWorktreeBinary: Boolean(binaryRepository?.linked),
      mainStorePath,
    }
  }
  const mainStorePath = path
  const repository = repositoryRootFromGit(cwd) ?? repositoryRootFromDotGit(cwd)
  return {
    path: mainStorePath,
    method: 'state-root',
    tried: [mainStorePath],
    registeredPath: null,
    repositoryRoot: repository?.root ?? null,
    // Location is per-user, but binary identity still owns initialization.
    initializable: isAuthorizedPlatformInstallation(
      binaryRoot,
      env,
      Boolean(binaryRepository && !binaryRepository.linked),
    ),
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
        'cleared by: set ORCH_DB to a scratch store before importing orchestrator/src/database/db.ts',
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

export function unauthorizedDatabaseInitializationMessage(path = DB_PATH): string {
  return (
    `refusing to initialize the default store: cannot establish an authorized ${PLATFORM_NAME} installation: ${path}\n` +
    'invariant: A default store is initialized only by a checkout or an installed distribution.\n' +
    `cleared by: run orch init-db from a checkout or reinstall ${PLATFORM_NAME}`
  )
}

export function legacyDatabaseRefusal(
  resolution: DatabaseResolution = DATABASE_RESOLUTION,
  env: StateEnvironment = process.env as StateEnvironment,
): string | null {
  if (resolution.method === 'ORCH_DB') return null
  if (embeddedDistributionManifest()) return null
  const binaryRepository = repositoryRootFromGit(ROOT) ?? repositoryRootFromDotGit(ROOT)
  if (!binaryRepository) return null
  const legacyStore = join(
    binaryRepository.root,
    'orchestrator',
    FROZEN_STATE_NAMES.orchestratorDatabase,
  )
  const legacyRuns = join(binaryRepository.root, 'orchestrator', FROZEN_STATE_NAMES.runsDirectory)
  return legacyStoreRefusal(
    {
      store: existsSync(legacyStore),
      wal: existsSync(`${legacyStore}-wal`),
      shm: existsSync(`${legacyStore}-shm`),
      runs: existsSync(legacyRuns),
      destinationStore: existsSync(resolution.path),
    },
    {
      legacyStore,
      destinationStore: resolution.path,
      legacyRuns,
      destinationRuns: resolveRunsDirectory(env),
    },
  )
}

export { resolveRunsDirectory } from '../../../shared/state-directory.ts'
