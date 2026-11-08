// concern: checkout and installed-release database update
/** Updates either installation kind while holding its migration drain or window. */

import { existsSync, realpathSync, renameSync } from 'node:fs'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  INSTALL_HOME_ENV,
  type InstallationIdentity,
  installRoot,
  resolveInstallationPaths,
  runningInstallationIdentity,
} from '../../../shared/install-root.ts'
import { resolveHubDatabase, resolveOrchestratorDatabase } from '../../../shared/state-directory.ts'
import {
  machineUpdateLockHeldEnvironment,
  withMachineUpdateLock,
} from '../../../shared/update-lock.ts'
import { realpathOrSpelled } from '../git/checkout-identity.ts'
import { git, targetGitEnvironment } from '../git/git-environment.ts'
import { verifyMainCheckoutInvariant } from '../project/main-checkout-invariant.ts'
import { projectAt } from '../project/projects.ts'
import { migrationInFlightRuns } from '../run/migration-in-flight-runs.ts'
import { setupIncrementalVacuumAfterMachineUpdate } from './database-commands.ts'
import { DATABASE_RESOLUTION, missingDatabaseMessage } from './database-location.ts'
import {
  DB_PATH,
  migrationAuthorityRefusal,
  withSynchronousDatabaseForMigrationStep,
} from './db.ts'
import {
  clearMachineUpdateIntent,
  localStoreJournalPositions,
  readMachineUpdateIntent,
  writeMachineUpdateIntent,
} from './machine-update-intent.ts'
import {
  decideMachineUpdateRecovery,
  type StoreJournalPositions,
} from './machine-update-recovery.ts'
import {
  type MigrationJournalEntry,
  validatedMigrationJournalEntries,
} from './migration-compatibility.ts'
import {
  clearMigrationDrain,
  migrationDrainForUpdate,
  setMigrationDrain,
  setMigrationDrainPhase,
} from './migration-drain.ts'
import { decideMigrationDrain } from './migration-drain-decision.ts'
import { waitForMigrationDrain } from './migration-drain-wait.ts'
import { ORCHESTRATOR_MIGRATION_JOURNAL_SOURCE } from './migration-journal-sources.ts'
import { claimMigrationWindow, clearMigrationWindow } from './migration-window.ts'
import { migrationJournal, migrationState, storeJournalPosition } from './migrations.ts'
import { migrateInstalledBinary, prepareReleaseUpdate } from './release-update.ts'
import {
  decideCurrentReleaseUpdate,
  decideUpdatePath,
  normalizeReleaseVersion,
} from './release-update-decision.ts'

type Presentation = { log(value: string): void }

function assertNoActiveDrain(active: { migration: string; pid: number } | null): void {
  if (!active) return
  throw new Error(
    `migration drain is already active for ${active.migration} ` +
      `(holder pid ${active.pid}); wait for ${PLATFORM_SLUG} machine update to finish`,
  )
}

function sameCheckout(left: string, right: string): boolean {
  return realpathOrSpelled(left) === realpathOrSpelled(right)
}

export function unregisteredMainCheckoutRefusal(
  target: string,
  project: { path: string } | null,
  same: (left: string, right: string) => boolean,
): string | null {
  if (project && same(target, project.path)) return null
  const binary = project
    ? `${project.path}/bin/${PLATFORM_SLUG}`
    : `the registered main checkout's bin/${PLATFORM_SLUG}`
  return (
    `refusing machine update: this installation's root ${target} is not a registered main checkout; ` +
    `run ${binary} machine update, or unset ${INSTALL_HOME_ENV} if it points elsewhere`
  )
}

function incomingJournal(
  cwd: string,
  branch: string,
  runGit: (cwd: string, args: string[]) => string,
): MigrationJournalEntry[] {
  const source = runGit(cwd, [
    'show',
    `origin/${branch}:${ORCHESTRATOR_MIGRATION_JOURNAL_SOURCE.path}`,
  ])
  const parsed = JSON.parse(source) as { entries?: unknown[] }
  if (!Array.isArray(parsed.entries)) throw new Error('incoming migration journal has no entries')
  return validatedMigrationJournalEntries(parsed.entries)
}

function runMigration(cwd: string): void {
  const result = Bun.spawnSync([`./bin/${PLATFORM_SLUG}`, 'machine', 'migrate'], {
    cwd,
    env: { ...targetGitEnvironment(cwd), ...machineUpdateLockHeldEnvironment() },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0)
    throw new Error(`${PLATFORM_SLUG} machine migrate failed with exit ${result.exitCode}`)
}

function cleanupFailureMessage(failure: unknown, cleanupError: unknown): string {
  const original = failure instanceof Error ? failure.message : String(failure)
  const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
  return `${original}; clearing the migration guard also failed: ${cleanup}`
}

function runWithCleanup(apply: () => void, cleanup: () => void): void {
  let failure: unknown
  try {
    apply()
  } catch (error) {
    failure = error
  }
  try {
    cleanup()
  } catch (cleanupError) {
    if (failure) throw new Error(cleanupFailureMessage(failure, cleanupError))
    throw cleanupError
  }
  if (failure) throw failure
}

async function runWithCleanupAsync(apply: () => Promise<void>, cleanup: () => void): Promise<void> {
  let failure: unknown
  try {
    await apply()
  } catch (error) {
    failure = error
  }
  try {
    cleanup()
  } catch (cleanupError) {
    if (failure) throw new Error(cleanupFailureMessage(failure, cleanupError))
    throw cleanupError
  }
  if (failure) throw failure
}

function applyImmediateUpdate(input: { migration: string | null; apply: () => void }): void {
  const migration = input.migration
  if (!migration) {
    input.apply()
    return
  }
  withSynchronousDatabaseForMigrationStep((database) => claimMigrationWindow(database, migration))
  runWithCleanup(input.apply, () =>
    withSynchronousDatabaseForMigrationStep((database) => clearMigrationWindow(database)),
  )
}

type UpdateDependencies = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  lockWaitMs?: number
  cwd?: string
  callerCwd?: string
  authorityRefusal?: () => string | null
  git?: (cwd: string, args: string[]) => string
  migrate?: (cwd: string) => void
  afterDrainPromoted?: () => void
  maintainStore?: (presentation: Presentation) => void
  identity?: InstallationIdentity
  updateDistribution?: typeof updateDistribution
  runLaunchAgentsRefreshVerb?: (binary: string) => void
  project?: (
    cwd: string,
    database: import('bun:sqlite').Database,
  ) => {
    name: string
    path: string
    settings: { trunk?: string }
  } | null
  verifyMainCheckout?: (
    path: string,
    trunk: string,
    git: (cwd: string, args: string[]) => string,
  ) => void
}

function runLaunchAgentsRefreshVerb(binary: string): void {
  const result = Bun.spawnSync([binary, 'machine', 'launch-agents', 'refresh'], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `launch-agent refresh failed with exit ${result.exitCode}; run ${binary} machine launch-agents refresh`,
    )
  }
}

function maintainStoreAfterUpdate(
  presentation: Presentation,
  maintainStore: (presentation: Presentation) => void,
): void {
  try {
    maintainStore(presentation)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    presentation.log(
      `incremental vacuum setup skipped: ${message}; retry with ${PLATFORM_SLUG} machine update`,
    )
  }
}

async function applyWithMigrationGuard(input: {
  presentation: Presentation
  decision: ReturnType<typeof decideMigrationDrain>
  pendingMigration: string | null
  apply: () => void
  deps: UpdateDependencies
}): Promise<void> {
  const { deps, presentation } = input
  if (input.decision.action === 'fence') {
    const migration = input.decision.migration
    withSynchronousDatabaseForMigrationStep((database) =>
      setMigrationDrain(database, migration, 'draining'),
    )
    await runWithCleanupAsync(
      async () => {
        const now = deps.now ?? Date.now
        const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
        const drainStartedAt = now()
        const inFlight = () =>
          withSynchronousDatabaseForMigrationStep((database) => migrationInFlightRuns(database))
        for (;;) {
          await waitForMigrationDrain({
            migration,
            presentation,
            startedAt: drainStartedAt,
            now,
            sleep,
            inFlight,
          })
          withSynchronousDatabaseForMigrationStep((database) =>
            setMigrationDrainPhase(database, 'migrating'),
          )
          deps.afterDrainPromoted?.()
          const raced = inFlight()
          if (raced.length === 0) break
          withSynchronousDatabaseForMigrationStep((database) =>
            setMigrationDrainPhase(database, 'draining'),
          )
        }
        input.apply()
      },
      () => {
        withSynchronousDatabaseForMigrationStep((database) => clearMigrationDrain(database))
      },
    )
    return
  }
  applyImmediateUpdate({ migration: input.pendingMigration, apply: input.apply })
}

async function updateDistribution(input: {
  presentation: Presentation
  manifest: Extract<InstallationIdentity, { kind: 'distribution' }>['manifest']
  requestedVersion?: string
  deps: UpdateDependencies
}): Promise<void> {
  const requested = input.requestedVersion
    ? normalizeReleaseVersion(input.requestedVersion)
    : undefined
  const runningState = withSynchronousDatabaseForMigrationStep((database) =>
    migrationState(database),
  )
  if (runningState.ahead) throw new Error(`store is ahead at migration ${runningState.ahead}`)
  const prepared = await prepareReleaseUpdate({
    manifest: input.manifest,
    requestedVersion: requested,
    presentation: input.presentation,
  })
  if (prepared.action === 'prepared') {
    try {
      assertNoActiveDrain(
        withSynchronousDatabaseForMigrationStep((database) => migrationDrainForUpdate(database)),
      )
      await applyWithMigrationGuard({
        presentation: input.presentation,
        decision: prepared.update.decision.drain,
        pendingMigration: prepared.update.pendingMigration,
        apply: prepared.update.apply,
        deps: input.deps,
      })
    } finally {
      prepared.update.cleanup()
    }
    return
  }
  const current = decideCurrentReleaseUpdate(prepared.version, runningState.pending.length > 0)
  if (current.action === 'no-op') {
    input.presentation.log(current.message)
    return
  }
  const runningJournal = migrationJournal()
  const migration = withSynchronousDatabaseForMigrationStep((database) => {
    const position = storeJournalPosition(database, runningJournal)
    if (position.state === 'pending-not-found') {
      throw new Error(`running journal does not contain pending migration ${position.migration}`)
    }
    return {
      decision: decideMigrationDrain({ journal: runningJournal, storeVersion: position.index }),
      pendingMigration: runningJournal[position.index]?.tag ?? null,
      activeDrain: migrationDrainForUpdate(database),
    }
  })
  assertNoActiveDrain(migration.activeDrain)
  await applyWithMigrationGuard({
    presentation: input.presentation,
    decision: migration.decision,
    pendingMigration: migration.pendingMigration,
    apply: () => migrateInstalledBinary(realpathSync(process.execPath)),
    deps: input.deps,
  })
  input.presentation.log(current.message)
}

function restoreMainAfterMigrationFailure(input: {
  target: string
  before: string
  runGit: (cwd: string, args: string[]) => string
  cause: unknown
  beforePositions: StoreJournalPositions
}): never {
  const migrationFailure = input.cause instanceof Error ? input.cause.message : String(input.cause)
  try {
    input.runGit(input.target, ['reset', '--keep', input.before])
  } catch (restoreCause) {
    const restoreFailure =
      restoreCause instanceof Error ? restoreCause.message : String(restoreCause)
    const decision = decideMachineUpdateRecovery({
      before: input.beforePositions,
      swapped: { kind: 'checkout', target: input.target, priorCommit: input.before },
      restoreFailure,
    })
    throw new Error(`migration failed: ${migrationFailure}; ${decision.message}`)
  }
  throw new Error(
    `migration failed: ${migrationFailure}; main was restored to ${input.before}; ` +
      `rerun ${PLATFORM_SLUG} machine update`,
  )
}

function storePositionInIncomingJournal(
  database: Parameters<typeof storeJournalPosition>[0],
  journal: MigrationJournalEntry[],
): number {
  const position = storeJournalPosition(database, journal)
  if (position.state === 'pending-not-found') {
    throw new Error(`incoming journal does not contain pending migration ${position.migration}`)
  }
  return position.index
}

function handleMigrationFailureAfterPull(input: {
  target: string
  before: string
  journal: MigrationJournalEntry[]
  initialStoreVersion: number
  beforePositions: StoreJournalPositions
  runGit: (cwd: string, args: string[]) => string
  cause: unknown
}): never {
  const migrationFailure = input.cause instanceof Error ? input.cause.message : String(input.cause)
  let storeVersion: number | null = null
  try {
    storeVersion = withSynchronousDatabaseForMigrationStep((database) =>
      storePositionInIncomingJournal(database, input.journal),
    )
  } catch {}
  const afterPositions = localStoreJournalPositions()
  const decision = decideMachineUpdateRecovery({
    before: input.beforePositions,
    after: afterPositions,
    swapped: { kind: 'checkout', target: input.target, priorCommit: input.before },
  })
  if (decision.action === 'keep' || decision.action === 'manual') {
    const incomingJournalDetail =
      storeVersion === null || storeVersion === input.initialStoreVersion
        ? ''
        : `; the orchestrator journal position moved from ${input.initialStoreVersion} to ${storeVersion} in the incoming journal`
    throw new Error(
      `migration failed: ${migrationFailure}; main was left at the pulled commit; ` +
        `${decision.message}${incomingJournalDetail}`,
    )
  }
  restoreMainAfterMigrationFailure(input)
}

function recoverAbandonedMachineUpdate(
  presentation: Presentation,
  runGit: (cwd: string, args: string[]) => string,
): void {
  const intent = readMachineUpdateIntent()
  if (!intent) return
  const after = localStoreJournalPositions()
  const decision = decideMachineUpdateRecovery({ ...intent, after })
  if (decision.action === 'keep') {
    presentation.log(`recovered interrupted machine update: ${decision.message}`)
    clearMachineUpdateIntent()
    return
  }
  if (decision.action === 'manual') throw new Error(decision.message)
  try {
    if (intent.swapped.kind === 'checkout') {
      runGit(intent.swapped.target, ['reset', '--keep', intent.swapped.priorCommit])
    } else {
      renameSync(intent.swapped.priorBinary, intent.swapped.installedBinary)
    }
  } catch (error) {
    const restoreFailure = error instanceof Error ? error.message : String(error)
    throw new Error(decideMachineUpdateRecovery({ ...intent, after, restoreFailure }).message)
  }
  clearMachineUpdateIntent()
  presentation.log(`recovered interrupted machine update: ${decision.message}`)
}

function requiredLocalStoreJournalPositions() {
  const positions = localStoreJournalPositions()
  if (!positions) {
    const orchestrator = resolveOrchestratorDatabase(process.env)
    const hub = resolveHubDatabase(process.env)
    throw new Error(
      `store journal positions could not be read before update from ${orchestrator} and ${hub}; ` +
        `repair or remove the unreadable store, then rerun ${PLATFORM_SLUG} machine update`,
    )
  }
  return positions
}

function verifiedLandingBranch(
  project: { name: string; path: string; settings: { trunk?: string } },
  runGit: (cwd: string, args: string[]) => string,
): string {
  const branch = project.settings.trunk?.trim()
  if (!branch) throw new Error(`${project.name}: no registered landing branch`)
  const current = runGit(project.path, ['branch', '--show-current']) || '(detached HEAD)'
  if (current !== branch) {
    throw new Error(
      `refusing machine update: registered landing branch is ${branch}, but ${project.path} is on ${current}; ` +
        `check out ${branch} in ${project.path}`,
    )
  }
  return branch
}

export async function machineUpdateCommandUnderLock(
  presentation: Presentation,
  deps: UpdateDependencies = {},
  requestedVersion?: string,
): Promise<void> {
  if (!existsSync(DB_PATH)) throw new Error(missingDatabaseMessage())
  if (!deps.authorityRefusal && DATABASE_RESOLUTION.method === 'BOTTEGA_ORCHESTRATOR_DB') {
    throw new Error(
      `refusing machine update through BOTTEGA_ORCHESTRATOR_DB; run it from the main checkout without the override`,
    )
  }
  const authorityRefusal = (deps.authorityRefusal ?? migrationAuthorityRefusal)()
  if (authorityRefusal) throw new Error(authorityRefusal)
  const identity = deps.identity ?? runningInstallationIdentity(import.meta.dir, process.env)
  recoverAbandonedMachineUpdate(
    presentation,
    deps.git ?? ((workingDirectory, args) => git(args, workingDirectory)),
  )
  const path = decideUpdatePath(identity.kind, requestedVersion)
  if (path.action === 'refuse') throw new Error(path.reason)
  if (identity.kind === 'distribution') {
    await (deps.updateDistribution ?? updateDistribution)({
      manifest: identity.manifest,
      requestedVersion,
      presentation,
      deps,
    })
    const maintainStore = deps.maintainStore ?? setupIncrementalVacuumAfterMachineUpdate
    maintainStoreAfterUpdate(presentation, maintainStore)
    const refreshLaunchAgents = deps.runLaunchAgentsRefreshVerb ?? runLaunchAgentsRefreshVerb
    refreshLaunchAgents(realpathSync(process.execPath))
    return
  }
  const target = deps.cwd ?? installRoot()
  const callerCwd = deps.callerCwd ?? process.cwd()
  const runGit = deps.git ?? ((workingDirectory, args) => git(args, workingDirectory))
  const migrate = deps.migrate ?? runMigration
  const lookedUp = withSynchronousDatabaseForMigrationStep((database) =>
    (deps.project ?? projectAt)(target, database),
  )
  const unregistered = unregisteredMainCheckoutRefusal(target, lookedUp, sameCheckout)
  if (unregistered) throw new Error(unregistered)
  const project = lookedUp!
  const branch = verifiedLandingBranch(project, runGit)
  if (!sameCheckout(callerCwd, target)) {
    presentation.log(`updating the ${PLATFORM_NAME} checkout at ${target}`)
  }
  runGit(target, ['fetch', 'origin', branch])
  const journal = incomingJournal(target, branch, runGit)
  const initial = withSynchronousDatabaseForMigrationStep((database) => {
    const local = migrationState(database)
    if (local.ahead) throw new Error(`store is ahead at migration ${local.ahead}`)
    const storeVersion = storePositionInIncomingJournal(database, journal)
    const activeDrain = migrationDrainForUpdate(database)
    return {
      activeDrain,
      decision: decideMigrationDrain({ journal, storeVersion }),
      pendingMigration: journal[storeVersion]?.tag ?? null,
      storeVersion,
    }
  })
  assertNoActiveDrain(initial.activeDrain)
  try {
    await applyWithMigrationGuard({
      presentation,
      decision: initial.decision,
      pendingMigration: initial.pendingMigration,
      deps,
      apply: () => {
        const before = runGit(target, ['rev-parse', 'HEAD'])
        const beforePositions = requiredLocalStoreJournalPositions()
        writeMachineUpdateIntent({
          before: beforePositions,
          swapped: { kind: 'checkout', target, priorCommit: before },
        })
        runGit(target, ['pull', '--ff-only', 'origin', branch])
        try {
          migrate(target)
        } catch (cause) {
          handleMigrationFailureAfterPull({
            target,
            before,
            journal,
            initialStoreVersion: initial.storeVersion,
            beforePositions,
            runGit,
            cause,
          })
        }
      },
    })
  } finally {
    clearMachineUpdateIntent()
  }
  const maintainStore = deps.maintainStore ?? setupIncrementalVacuumAfterMachineUpdate
  maintainStoreAfterUpdate(presentation, maintainStore)
  const refreshLaunchAgents = deps.runLaunchAgentsRefreshVerb ?? runLaunchAgentsRefreshVerb
  refreshLaunchAgents(resolveInstallationPaths(target, {}).executable)
  ;(deps.verifyMainCheckout ?? verifyMainCheckoutInvariant)(target, branch, runGit)
}

export async function machineUpdateCommand(
  presentation: Presentation,
  deps: UpdateDependencies = {},
  requestedVersion?: string,
): Promise<void> {
  return withMachineUpdateLock(
    () => machineUpdateCommandUnderLock(presentation, deps, requestedVersion),
    { waitMs: deps.lockWaitMs, now: deps.now, sleep: deps.sleep },
  )
}
