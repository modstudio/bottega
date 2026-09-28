import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { FROZEN_STATE_NAMES, PLATFORM_SLUG } from './brand.ts'

export type StateEnvironment = Record<string, string | undefined>

/** The platform-specific override name is derived from the one canonical slug. */
export const STATE_HOME_ENV = `${PLATFORM_SLUG.toUpperCase()}_STATE_HOME`

/** Resolve the per-user state root using only the supplied environment. */
export function resolveStateRoot(env: StateEnvironment): string {
  const override = env[STATE_HOME_ENV]
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(
        `${STATE_HOME_ENV} must be an absolute state root; set it to an absolute path`,
      )
    }
    return override
  }
  const xdg = env.XDG_STATE_HOME
  if (xdg && isAbsolute(xdg)) return join(xdg, PLATFORM_SLUG)
  const home = env.HOME
  if (!home) {
    throw new Error(
      `cannot resolve ${PLATFORM_SLUG} state directory: set HOME, or set ${STATE_HOME_ENV} to an absolute state root`,
    )
  }
  return join(home, '.local', 'state', PLATFORM_SLUG)
}

export type StatePaths = {
  root: string
  orchestratorDirectory: string
  orchestratorDatabase: string
  orchestratorRuns: string
  hubDirectory: string
  hubDatabase: string
  retrievalDirectory: string
  retrievalDatabase: string
}

/** Compose every frozen state path from the single resolved root. */
export function resolveStatePaths(env: StateEnvironment): StatePaths {
  const root = resolveStateRoot(env)
  const orchestratorDirectory = join(root, 'orchestrator')
  const hubDirectory = join(root, 'hub')
  const retrievalDirectory = join(root, 'retrieval')
  return {
    root,
    orchestratorDirectory,
    orchestratorDatabase: join(orchestratorDirectory, FROZEN_STATE_NAMES.orchestratorDatabase),
    orchestratorRuns: join(orchestratorDirectory, FROZEN_STATE_NAMES.runsDirectory),
    hubDirectory,
    hubDatabase: join(hubDirectory, FROZEN_STATE_NAMES.hubDatabase),
    retrievalDirectory,
    retrievalDatabase: join(retrievalDirectory, FROZEN_STATE_NAMES.retrievalDatabase),
  }
}

export function concernStateDirectory(
  concern: 'orchestrator' | 'hub',
  env: StateEnvironment,
): string {
  const paths = resolveStatePaths(env)
  return concern === 'orchestrator' ? paths.orchestratorDirectory : paths.hubDirectory
}

/** Pending local-dashboard login tokens, denied to sandboxed workers. */
export function hubLoginTokenDirectory(env: StateEnvironment): string {
  return join(concernStateDirectory('hub', env), 'login-tokens')
}

/** Ensure the sandbox-denied login-token directory exists with private permissions. */
export function ensureHubLoginTokenDirectory(env: StateEnvironment): string {
  const directory = hubLoginTokenDirectory(env)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const pathStat = lstatSync(directory)
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error(`hub login-token path is not a directory: ${directory}`)
  }
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const descriptorStat = fstatSync(descriptor)
    const getuid = process.getuid
    if (!getuid) throw new Error('hub login-token directory ownership is unavailable')
    const uid = getuid()
    if (!descriptorStat.isDirectory() || descriptorStat.uid !== uid) {
      throw new Error(`hub login-token directory is not owned by the current user: ${directory}`)
    }
    fchmodSync(descriptor, 0o700)
  } finally {
    closeSync(descriptor)
  }
  return directory
}

export function resolveOrchestratorDatabase(env: StateEnvironment): string {
  return env.ORCH_DB ? resolve(env.ORCH_DB) : resolveStatePaths(env).orchestratorDatabase
}

export function resolveRunsDirectory(env: StateEnvironment): string {
  if (env.ORCH_RUNS) return resolve(env.ORCH_RUNS)
  if (env.ORCH_DB) return join(dirname(resolve(env.ORCH_DB)), FROZEN_STATE_NAMES.runsDirectory)
  return resolveStatePaths(env).orchestratorRuns
}

export function resolveHubDatabase(env: StateEnvironment): string {
  return env.HUB_DB ? resolve(env.HUB_DB) : resolveStatePaths(env).hubDatabase
}

export function resolveRetrievalDatabase(env: StateEnvironment): string {
  return resolveStatePaths(env).retrievalDatabase
}

export type LegacyStoreMove = {
  legacyStore: string
  destinationStore: string
  legacyRuns?: string
  destinationRuns?: string
}

export type LegacyStoreFacts = {
  store: boolean
  wal: boolean
  shm: boolean
  runs?: boolean
  destinationStore: boolean
}

/** Pure refusal decision shared by both stores; callers supply filesystem facts. */
export function legacyStoreRefusal(facts: LegacyStoreFacts, move: LegacyStoreMove): string | null {
  const paths: [string, string][] = []
  if (facts.store) paths.push([move.legacyStore, move.destinationStore])
  if (facts.wal) paths.push([`${move.legacyStore}-wal`, `${move.destinationStore}-wal`])
  if (facts.shm) paths.push([`${move.legacyStore}-shm`, `${move.destinationStore}-shm`])
  if (facts.runs && move.legacyRuns && move.destinationRuns) {
    paths.push([move.legacyRuns, move.destinationRuns])
  }
  if (paths.length === 0) return null
  return (
    `refusing to open state while legacy state exists${facts.destinationStore ? ' and the destination store already exists' : ''}\n` +
    `check any existing destination before moving, then move the existing state before retrying (sidecars and runs when present):\n` +
    paths.map(([source, destination]) => `  ${source} -> ${destination}`).join('\n')
  )
}

if (import.meta.main) {
  const concern = process.argv[2]
  const kind = process.argv[3]
  const env = process.env as StateEnvironment
  if (concern === 'environment' && kind === undefined) console.log(STATE_HOME_ENV)
  else if (concern === 'root' && kind === undefined) console.log(resolveStateRoot(env))
  else if (concern === 'orchestrator' && kind === 'database') {
    console.log(resolveOrchestratorDatabase(env))
  } else if (concern === 'orchestrator' && kind === 'runs') {
    console.log(resolveRunsDirectory(env))
  } else if (concern === 'hub' && kind === 'database') {
    console.log(resolveHubDatabase(env))
  } else {
    throw new Error(
      'working form: bun shared/state-directory.ts environment | root | orchestrator <database|runs> | hub database',
    )
  }
}
