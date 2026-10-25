// concern: setup state-file migration
/** Decides and applies the default orchestrator database rename without opening SQLite. */

import { link, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { observeBoundedSubprocess } from '../../../shared/process-identity.ts'
import {
  LEGACY_ORCHESTRATOR_DATABASE,
  resolveStatePaths,
  type StateEnvironment,
} from '../../../shared/state-directory.ts'
import {
  DATABASE_SIDECAR_SUFFIXES,
  type DatabaseFileSuffix,
} from '../database/database-file-family.ts'

export type StateFileNamePair = { oldPath: string; newPath: string }
type StateFileHolder = { pid: number; command: string }
export type StateFileHolderObservation =
  | { kind: 'known'; holders: StateFileHolder[] }
  | { kind: 'unknown'; reason: string }
export type StateFileMoveFacts = {
  explicitPath: boolean
  old: StateFileFamilyFacts
  current: StateFileFamilyFacts
  holders: StateFileHolderObservation
}
export type StateFileMoveDecision =
  | { kind: 'leave-explicit' | 'noop' }
  | { kind: 'move'; suffixes: DatabaseFileSuffix[] }
  | { kind: 'refuse'; reason: string }

const STATE_FILE_LSOF_TIMEOUT_MS = 10_000

type StateFileFamilyFacts = { store: boolean; wal: boolean; shm: boolean; journal: boolean }

function filePresent(family: StateFileFamilyFacts, suffix: DatabaseFileSuffix): boolean {
  if (suffix === '') return family.store
  return family[suffix.slice(1) as 'wal' | 'shm' | 'journal']
}

/** Pure policy for the default orchestrator state-file rename. */
export function stateFileMoveDecision(
  pair: StateFileNamePair,
  facts: StateFileMoveFacts,
): StateFileMoveDecision {
  if (facts.explicitPath) return { kind: 'leave-explicit' }
  const suffixes = DATABASE_SIDECAR_SUFFIXES.filter((suffix) => filePresent(facts.old, suffix))
  if (suffixes.length === 0) return { kind: 'noop' }
  const interruptedMove = !facts.old.store && facts.current.store
  const collisionCandidates = interruptedMove
    ? suffixes.filter((suffix) => suffix !== '')
    : DATABASE_SIDECAR_SUFFIXES
  const collisions = collisionCandidates.filter((suffix) => filePresent(facts.current, suffix))
  if (collisions.length) {
    if (interruptedMove) {
      return {
        kind: 'refuse',
        reason: `refusing interrupted state-file migration because sidecars exist under both names: ${collisions
          .flatMap((suffix) => [`${pair.oldPath}${suffix}`, `${pair.newPath}${suffix}`])
          .join(
            ', ',
          )}; determine which sidecar contains the live state and preserve it under the destination name, then retry`,
      }
    }
    return {
      kind: 'refuse',
      reason: `refusing state-file migration because both names exist: ${collisions
        .flatMap((suffix) => [`${pair.oldPath}${suffix}`, `${pair.newPath}${suffix}`])
        .join(', ')}; decide which database holds the live store, remove the other, then retry`,
    }
  }
  if (facts.holders.kind === 'unknown') {
    return {
      kind: 'refuse',
      reason: `refusing state-file migration because open-file holders could not be determined: ${facts.holders.reason}; determine and stop every holder, then retry`,
    }
  }
  if (facts.holders.holders.length) {
    return {
      kind: 'refuse',
      reason: `refusing state-file migration while files are open: ${facts.holders.holders
        .map(({ pid, command }) => `pid ${pid} (${command})`)
        .join(', ')}; stop the listed holders, then retry`,
    }
  }
  return { kind: 'move', suffixes }
}

function stateFileHolders(paths: string[]): StateFileHolderObservation {
  let observation: ReturnType<typeof Bun.spawnSync>
  try {
    ;({ process: observation } = observeBoundedSubprocess(
      'lsof',
      ['lsof', '-nP', '-Fpc', '--', ...paths],
      { stdout: 'pipe', stderr: 'pipe' },
      STATE_FILE_LSOF_TIMEOUT_MS,
    ))
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
  const error = observation.stderr?.toString().trim() ?? ''
  if (observation.exitCode === 1 && !error) return { kind: 'known', holders: [] }
  if (observation.exitCode !== 0) {
    return { kind: 'unknown', reason: error || `lsof exited ${String(observation.exitCode)}` }
  }
  const holders = new Map<number, StateFileHolder>()
  let pid: number | null = null
  for (const line of (observation.stdout?.toString() ?? '').split('\n')) {
    if (line.startsWith('p')) {
      const parsed = Number(line.slice(1))
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null
    } else if (line.startsWith('c') && pid !== null) {
      holders.set(pid, { pid, command: line.slice(1) || '<unknown>' })
    }
  }
  return {
    kind: 'known',
    holders: [...holders.values()]
      .filter(({ pid }) => pid !== globalThis.process.pid)
      .sort((a, b) => a.pid - b.pid),
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function facts(path: string): Promise<StateFileFamilyFacts> {
  return {
    store: await exists(path),
    wal: await exists(`${path}-wal`),
    shm: await exists(`${path}-shm`),
    journal: await exists(`${path}-journal`),
  }
}

export function defaultStateFilePair(env: StateEnvironment): StateFileNamePair | null {
  if (env.BOTTEGA_ORCHESTRATOR_DB) return null
  const state = resolveStatePaths(env)
  return {
    oldPath: join(state.orchestratorDirectory, LEGACY_ORCHESTRATOR_DATABASE),
    newPath: state.orchestratorDatabase,
  }
}

export async function decideStateFileMove(
  pair: StateFileNamePair,
  holders: (paths: string[]) => StateFileHolderObservation = stateFileHolders,
): Promise<StateFileMoveDecision> {
  const old = await facts(pair.oldPath)
  const current = await facts(pair.newPath)
  const paths = DATABASE_SIDECAR_SUFFIXES.filter((suffix) => filePresent(old, suffix)).map(
    (suffix) => `${pair.oldPath}${suffix}`,
  )
  return stateFileMoveDecision(pair, {
    explicitPath: false,
    old,
    current,
    holders: paths.length ? holders(paths) : { kind: 'known', holders: [] },
  })
}

export async function renameStateFiles(
  pair: StateFileNamePair,
  suffixes: DatabaseFileSuffix[],
  moveFile: (source: string, destination: string) => Promise<void> = async (
    source,
    destination,
  ) => {
    await link(source, destination)
    try {
      await unlink(source)
    } catch (error) {
      try {
        await unlink(destination)
      } catch (cleanupError) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; removing the new hard link also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        )
      }
      throw error
    }
  },
): Promise<void> {
  const moved: DatabaseFileSuffix[] = []
  try {
    for (const suffix of suffixes) {
      await moveFile(`${pair.oldPath}${suffix}`, `${pair.newPath}${suffix}`)
      moved.push(suffix)
    }
  } catch (error) {
    const rollbackErrors: string[] = []
    for (const suffix of moved.toReversed()) {
      try {
        await moveFile(`${pair.newPath}${suffix}`, `${pair.oldPath}${suffix}`)
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        )
      }
    }
    const detail = error instanceof Error ? error.message : String(error)
    const rollback = rollbackErrors.length
      ? `; rollback also failed: ${rollbackErrors.join('; ')}`
      : ''
    throw new Error(
      `state-file rename failed from ${pair.oldPath} to ${pair.newPath}: ${detail}${rollback}; keep the database and all sidecars under one name, then retry`,
    )
  }
}
