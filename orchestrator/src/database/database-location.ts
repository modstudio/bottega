import { existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { embeddedDistributionManifest } from '../../../shared/embedded-assets.ts'
import { borrowedCheckoutOf, inspectionGitEnv } from '../../../shared/git.ts'
import { isAuthorizedPlatformInstallation } from '../../../shared/install-root.ts'
import {
  LEGACY_ORCHESTRATOR_DATABASE,
  legacyStoreRefusal,
  realPathForPotentialPath,
  resolveOrchestratorDatabase,
  resolveStatePaths,
  type StateEnvironment,
  temporaryStateStoreMigrationAllowed,
} from '../../../shared/state-directory.ts'

export type DatabaseResolutionMethod = 'BOTTEGA_ORCHESTRATOR_DB' | 'state-root'

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
  cwd: string | undefined = undefined,
  env: StateEnvironment = process.env as StateEnvironment,
  binaryRoot = ROOT,
): DatabaseResolution {
  const binaryRepository = embeddedDistributionManifest()
    ? null
    : (repositoryRootFromGit(binaryRoot) ?? repositoryRootFromDotGit(binaryRoot))
  let callerCwd = cwd
  if (callerCwd === undefined) {
    try {
      callerCwd = process.cwd()
    } catch (error) {
      callerCwd = missingWorkingDirectoryFallback(error, {
        mainCheckout: env.BOTTEGA_MAIN_CHECKOUT,
        binaryRepositoryRoot: binaryRepository?.root ?? null,
        binaryRoot,
      })
    }
  }
  const path = resolveOrchestratorDatabase(env)
  if (env.BOTTEGA_ORCHESTRATOR_DB) {
    // BOTTEGA_ORCHESTRATOR_DB is independently sufficient. When HOME is available, retaining
    // the default path lets linked-worktree binaries still recognize an
    // override that points back at the shared store.
    let mainStorePath = path
    try {
      mainStorePath = resolveStatePaths(env).orchestratorDatabase
    } catch {}
    return {
      path,
      method: 'BOTTEGA_ORCHESTRATOR_DB',
      tried: [path],
      registeredPath: null,
      repositoryRoot: null,
      initializable: true,
      linkedWorktreeBinary: Boolean(binaryRepository?.linked),
      mainStorePath,
    }
  }
  const mainStorePath = path
  const repository = repositoryRootFromGit(callerCwd) ?? repositoryRootFromDotGit(callerCwd)
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

/** Where a process whose working directory was removed continues; any other cwd failure is rethrown. */
export function missingWorkingDirectoryFallback(
  error: unknown,
  facts: { mainCheckout?: string; binaryRepositoryRoot: string | null; binaryRoot: string },
): string {
  if ((error as { code?: unknown } | null)?.code !== 'ENOENT') throw error
  return facts.mainCheckout ?? facts.binaryRepositoryRoot ?? dirname(facts.binaryRoot)
}

/** Move a process out of an already-removed directory before loading command implementations. */
export function recoverMissingWorkingDirectory(): string {
  try {
    return process.cwd()
  } catch (error) {
    const recovered = missingWorkingDirectoryFallback(error, {
      mainCheckout: process.env.BOTTEGA_MAIN_CHECKOUT,
      binaryRepositoryRoot:
        repositoryRootFromGit(ROOT)?.root ?? repositoryRootFromDotGit(ROOT)?.root ?? null,
      binaryRoot: ROOT,
    })
    process.chdir(recovered)
    return recovered
  }
}

/** A test process never falls back to the live orchestrator store. */
export function decideOrchestratorDatabasePath(
  isTestProcess: boolean,
  method: DatabaseResolutionMethod,
  resolvedPath: string,
): string {
  if (isTestProcess && method !== 'BOTTEGA_ORCHESTRATOR_DB') {
    throw new Error(
      `test process refuses orchestrator database: BOTTEGA_ORCHESTRATOR_DB resolved <unset>; live store is ${resolvedPath}\n` +
        'invariant: A test suite never falls back to the live orchestrator database.\n' +
        'cleared by: set BOTTEGA_ORCHESTRATOR_DB to a scratch store before importing orchestrator/src/database/db.ts',
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
  return (
    `orchestrator database does not exist: ${path}\n` +
    'invariant: An absent BOTTEGA_ORCHESTRATOR_DB path is a mistake, not a request to create a store.\n' +
    'cleared by: unset BOTTEGA_ORCHESTRATOR_DB to use the installation store, or name an existing database'
  )
}

export function unauthorizedDatabaseInitializationMessage(path = DB_PATH): string {
  return (
    `refusing to initialize the default store: cannot establish an authorized ${PLATFORM_NAME} installation: ${path}\n` +
    'invariant: A default store is initialized only by a checkout or an installed distribution.\n' +
    `cleared by: run the command from the main checkout or reinstall ${PLATFORM_NAME}`
  )
}

export function linkedWorktreeDatabaseInitializationMessage(): string {
  return (
    'refusing to migrate the store from a linked-worktree binary; run it from the main checkout\n' +
    "invariant: Only the main checkout's binary migrates the store.\n" +
    `cleared by: ${PLATFORM_SLUG} machine migrate`
  )
}

/** A linked binary may migrate only an isolated store whose real path is under OS temporary state. */
export function linkedWorktreeMigrationAllowed(path: string): boolean {
  return temporaryStateStoreMigrationAllowed(
    realPathForPotentialPath(path),
    realPathForPotentialPath(tmpdir()),
  )
}

/** A worker reads the store; a schema change belongs to the operator's own update. */
export function workerStoreMigrationRefusal(path = DB_PATH): string {
  return (
    `refusing to migrate the orchestrator store from a worker: ${path}\n` +
    'invariant: A worker never changes the store it reads, because a schema change under a live process breaks every run in flight.\n' +
    `cleared by: the operator runs ${PLATFORM_SLUG} machine update from the main checkout`
  )
}

/** A worker is given the store it reads; creating the shared one belongs to the operator. */
export function workerStoreCreationRefusal(path = DB_PATH): string {
  return (
    `refusing to create the orchestrator store from a worker: ${path}\n` +
    'invariant: A worker never creates the shared store it reads; an isolated store under OS temporary state is not the shared store.\n' +
    `cleared by: the operator runs ${PLATFORM_SLUG} machine update from the main checkout`
  )
}

/**
 * The worker fact is a plain argument, gathered once by the adapter that owns the process
 * environment: a decision does not read the environment itself.
 */
export function implicitDatabaseCreationRefusal(
  resolution: DatabaseResolution = DATABASE_RESOLUTION,
  path = resolution.path,
  workerCaller: boolean,
): string | null {
  if (resolution.method === 'BOTTEGA_ORCHESTRATOR_DB') return missingDatabaseMessage(path)
  const temporaryStore = linkedWorktreeMigrationAllowed(path)
  if (workerCaller && !temporaryStore) return workerStoreCreationRefusal(path)
  if (resolution.linkedWorktreeBinary) {
    return temporaryStore ? null : linkedWorktreeDatabaseInitializationMessage()
  }
  if (!resolution.initializable) return unauthorizedDatabaseInitializationMessage(path)
  return null
}

/**
 * Existing stores retain the linked-worktree migration refusal unless they live in the OS
 * temporary directory. A worker caller never migrates them: an isolated store under OS
 * temporary state is the one a worker test leg may still create and migrate.
 *
 * `workerCaller` is required, so a caller cannot fall back to reading the environment itself.
 */
export function existingDatabaseMigrationRefusal(
  resolution: DatabaseResolution = DATABASE_RESOLUTION,
  workerCaller: boolean,
): string | null {
  const temporaryStore = linkedWorktreeMigrationAllowed(resolution.path)
  if (workerCaller && !temporaryStore) return workerStoreMigrationRefusal(resolution.path)
  return resolution.linkedWorktreeBinary && !temporaryStore
    ? linkedWorktreeDatabaseInitializationMessage()
    : null
}

export function legacyDatabaseRefusal(
  resolution: DatabaseResolution = DATABASE_RESOLUTION,
  env: StateEnvironment = process.env as StateEnvironment,
): string | null {
  if (resolution.method === 'BOTTEGA_ORCHESTRATOR_DB') return null
  const state = resolveStatePaths(env)
  const legacyStore = join(state.orchestratorDirectory, LEGACY_ORCHESTRATOR_DATABASE)
  const destinationStore = existsSync(resolution.path)
  const legacyFacts = {
    store: existsSync(legacyStore),
    wal: existsSync(`${legacyStore}-wal`),
    shm: existsSync(`${legacyStore}-shm`),
    journal: existsSync(`${legacyStore}-journal`),
    destinationStore,
  }
  const interruptedMove =
    !legacyFacts.store &&
    destinationStore &&
    (legacyFacts.wal || legacyFacts.shm || legacyFacts.journal)
  return legacyStoreRefusal(
    legacyFacts,
    {
      legacyStore,
      destinationStore: resolution.path,
    },
    interruptedMove
      ? `${PLATFORM_SLUG} machine setup apply completes the interrupted move before retrying`
      : destinationStore
        ? 'decide which database holds the live store, then remove the other before retrying'
        : `run ${PLATFORM_SLUG} machine setup apply before retrying`,
  )
}

export { resolveRunsDirectory } from '../../../shared/state-directory.ts'
