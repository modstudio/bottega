import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBoundedSync } from '../../shared/bounded-process.ts'
import {
  FROZEN_ENV_NAMES,
  FROZEN_STATE_NAMES,
  PLATFORM_NAME,
  PLATFORM_SLUG,
} from '../../shared/brand.ts'
import { mainCheckoutOf } from '../../shared/git.ts'
import { checkoutIsUnderProject } from '../../shared/project-path.ts'
import { DATABASE_RESOLUTION } from '../src/database/database-location.ts'
import {
  applyMigrations,
  MIGRATIONS_FOLDER,
  storeMigrationState,
} from '../src/database/migrations.ts'
import { GATE_FACTS_ENV } from '../src/gate/gate-facts.ts'
import { assertGateFactsFormat } from '../src/gate/gate-facts-contract.ts'

export type BranchStoreKind = 'current' | 'behind' | 'ahead' | 'absent'

export type LocalGateRegistrationProbe =
  | { kind: 'registered' }
  | { kind: 'unregistered' }
  | { kind: 'absent-store' }
  | { kind: 'absent-register' }
  | { kind: 'unreadable-store'; detail: string }

export type LocalGateRegistrationDecision =
  | { kind: 'run' }
  | { kind: 'skip'; message: string }
  | { kind: 'fail'; message: string }

/** Pure policy for the machine-state checks that require this checkout's register row. */
export function localGateRegistrationDecision(
  checkout: string,
  probe: LocalGateRegistrationProbe,
  registrationCheckout = checkout,
): LocalGateRegistrationDecision {
  if (probe.kind === 'registered') return { kind: 'run' }
  if (probe.kind === 'unreadable-store') {
    return {
      kind: 'fail',
      message: `cannot read the project register for checkout ${checkout}: ${probe.detail}`,
    }
  }
  const reason =
    probe.kind === 'absent-store'
      ? 'the orchestrator store is absent'
      : probe.kind === 'absent-register'
        ? 'the orchestrator store has no project register'
        : 'the project register has no project containing this checkout'
  return {
    kind: 'skip',
    message: `checkout ${checkout} is not registered because ${reason}; remedy: ${PLATFORM_SLUG} project add ${JSON.stringify(registrationCheckout)}`,
  }
}

/** Read only the registration facts needed by the local machine-state check policy. */
export function probeLocalGateRegistration(
  checkout: string,
  storePath: string | null,
): LocalGateRegistrationProbe {
  if (!storePath) return { kind: 'absent-store' }
  let database: Database
  try {
    database = new Database(storePath, { readonly: true })
  } catch (cause) {
    return {
      kind: 'unreadable-store',
      detail: String((cause as Error).message ?? cause),
    }
  }
  try {
    const projectTable = database
      .query("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='project'")
      .get()
    if (!projectTable) return { kind: 'absent-register' }
    const rows = database.query('SELECT path, retired_at FROM project').all() as {
      path: string
      retired_at: string | null
    }[]
    // Deliberately omit git-toplevel validation: a false positive makes the full check fail closed.
    const registered = rows.some(
      (row) => row.retired_at === null && checkoutIsUnderProject(checkout, row.path),
    )
    return registered ? { kind: 'registered' } : { kind: 'unregistered' }
  } catch (cause) {
    return {
      kind: 'unreadable-store',
      detail: String((cause as Error).message ?? cause),
    }
  } finally {
    database.close()
  }
}

export function localGateRegistration(checkout: string, storePath: string | null) {
  return localGateRegistrationDecision(
    checkout,
    probeLocalGateRegistration(checkout, storePath),
    mainCheckoutOf(checkout) ?? checkout,
  )
}

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

export type CanonDriftStoreSource =
  | { kind: 'direct' }
  | { kind: 'migrated-scratch' }
  | { kind: 'gate-facts' }

/** Pure policy for the store source used by the canon-drift gate leg. */
export function canonDriftStoreSource(storeKind: BranchStoreKind): CanonDriftStoreSource {
  if (storeKind === 'behind') return { kind: 'migrated-scratch' }
  if (storeKind === 'ahead') return { kind: 'gate-facts' }
  return { kind: 'direct' }
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

function mainGateFactsSnapshot(dir: string): GateFactsSnapshot {
  const supplied = process.env[GATE_FACTS_ENV]
  if (supplied) {
    const started = performance.now()
    try {
      assertGateFactsFormat(readFileSync(supplied, 'utf8'))
      return { path: supplied, elapsedMs: performance.now() - started }
    } catch (cause) {
      throw new Error(
        `the supplied gate-facts snapshot ${supplied} is unreadable or invalid: ${String((cause as Error).message ?? cause)}; remedy: retry the run so the dispatcher writes a fresh snapshot`,
      )
    }
  }
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
  const child = startBoundedSync(
    [join(main, 'bin', PLATFORM_SLUG), 'machine', 'gate-facts', '--out', path],
    { budget: 'self-cli', env },
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

export function withMainGateFactsSnapshot<T>(
  storeKind: BranchStoreKind,
  dir: string,
  onUnavailable: (cause: unknown) => T,
  run: (snapshot: GateFactsSnapshot) => T,
): T {
  let snapshot: GateFactsSnapshot | null = null
  let snapshotError: unknown
  try {
    snapshot = mainGateFactsSnapshot(dir)
  } catch (cause) {
    snapshotError = cause
  }
  const source = gateStoreSource(storeKind, snapshot !== null)
  if (source.kind === 'refuse') return onUnavailable(snapshotError)
  if (source.kind !== 'gate-facts' || snapshot === null) {
    throw new Error(`gate-facts snapshot requested for ${storeKind} store`)
  }
  return run(snapshot)
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
