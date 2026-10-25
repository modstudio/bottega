import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FROZEN_ENV_NAMES,
  FROZEN_STATE_NAMES,
  PLATFORM_NAME,
  PLATFORM_SLUG,
} from '../../shared/brand.ts'
import { assertGateFactsFormat } from '../../shared/gate-facts-contract.ts'
import { DATABASE_RESOLUTION } from '../src/database/database-location.ts'
import {
  applyMigrations,
  MIGRATIONS_FOLDER,
  storeMigrationState,
} from '../src/database/migrations.ts'

export const GATE_FACTS_ENV = FROZEN_ENV_NAMES.gateFacts

export type BranchStoreKind = 'current' | 'behind' | 'ahead' | 'absent'

export type GateStoreSource =
  | { kind: 'existing'; storeKind: Exclude<BranchStoreKind, 'ahead'> }
  | { kind: 'gate-facts' }
  | { kind: 'refuse' }

export function gateStoreSource(
  storeKind: BranchStoreKind,
  snapshotAvailable: boolean,
): GateStoreSource {
  if (storeKind !== 'ahead') return { kind: 'existing', storeKind }
  return snapshotAvailable ? { kind: 'gate-facts' } : { kind: 'refuse' }
}

export function classifyStore(path: string | null, folder = MIGRATIONS_FOLDER): BranchStoreKind {
  if (!path || !existsSync(path)) return 'absent'
  const database = new Database(path, { readonly: true })
  try {
    database.exec('PRAGMA busy_timeout = 15000')
    return storeMigrationState(database, folder)
  } finally {
    database.close()
  }
}

export function liveStorePath(): string | null {
  if (process.env.BOTTEGA_ORCHESTRATOR_DB)
    return existsSync(process.env.BOTTEGA_ORCHESTRATOR_DB)
      ? process.env.BOTTEGA_ORCHESTRATOR_DB
      : null
  for (const path of [DATABASE_RESOLUTION.mainStorePath, DATABASE_RESOLUTION.path]) {
    if (path && existsSync(path)) return path
  }
  return null
}

export function withBranchStoreScratch<T>(name: string, fn: (dir: string) => T): T {
  const base = process.env.BOTTEGA_SCRATCH
    ? join(process.env.BOTTEGA_SCRATCH, name)
    : join(tmpdir(), `orch-${name}`)
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'store-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export type GateFactsSnapshot = { path: string; elapsedMs: number }

export function mainGateFactsSnapshot(dir: string): GateFactsSnapshot {
  const main = process.env[FROZEN_ENV_NAMES.mainCheckout]
  if (!main) {
    throw new Error(
      `${FROZEN_ENV_NAMES.mainCheckout} is unset; remedy: run the gate from a ${PLATFORM_NAME}-managed worktree carrying its main-checkout path`,
    )
  }
  const path = join(dir, 'gate-facts.json')
  const started = performance.now()
  const env = { ...process.env }
  delete env[GATE_FACTS_ENV]
  const child = Bun.spawnSync(
    [join(main, 'bin', PLATFORM_SLUG), 'machine', 'gate-facts', '--out', path],
    {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const elapsedMs = performance.now() - started
  if (child.exitCode !== 0) {
    const detail = child.stderr.toString().trim() || child.stdout.toString().trim()
    throw new Error(
      `the main checkout could not write gate facts (exit ${child.exitCode ?? 1})${detail ? `: ${detail}` : ''}; remedy: run ${join(main, 'bin', PLATFORM_SLUG)} machine update, then retry the gate`,
    )
  }
  try {
    assertGateFactsFormat(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw new Error(
      `${String((cause as Error).message ?? cause)}; remedy: update this branch to a gate-facts format it understands, then retry the gate`,
    )
  }
  return { path, elapsedMs }
}

export function snapshotStore(source: string, destDir: string): string {
  const destination = join(destDir, FROZEN_STATE_NAMES.orchestratorDatabase)
  const database = new Database(source, { readonly: true })
  try {
    database.exec('PRAGMA busy_timeout = 15000')
    database.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`)
  } finally {
    database.close()
  }
  return destination
}

export function migrateStore(path: string): void {
  const database = new Database(path)
  try {
    database.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
    applyMigrations(database)
  } finally {
    database.close()
  }
}

export function mintFixtureStore(destDir: string): string {
  const path = join(destDir, FROZEN_STATE_NAMES.orchestratorDatabase)
  const database = new Database(path, { create: true })
  try {
    database.exec('PRAGMA foreign_keys = ON;')
    applyMigrations(database)
  } finally {
    database.close()
  }
  return path
}
