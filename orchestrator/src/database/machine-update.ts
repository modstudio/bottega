// concern: main-checkout database update
/** Adapts Git, the live store, and migration execution around the drain decision. */

import { existsSync } from 'node:fs'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { INSTALL_HOME_ENV, installRoot } from '../../../shared/install-root.ts'
import { realpathOrSpelled } from '../git/checkout-identity.ts'
import { git, targetGitEnvironment } from '../git/git-environment.ts'
import { projectAt } from '../project/projects.ts'
import { migrationInFlightRuns } from '../run/migration-in-flight-runs.ts'
import { DATABASE_RESOLUTION, missingDatabaseMessage } from './database-location.ts'
import {
  DB_PATH,
  migrationAuthorityRefusal,
  withSynchronousDatabaseForMigrationStep,
} from './db.ts'
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
import { migrationState, storeJournalPosition } from './migrations.ts'

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
    env: targetGitEnvironment(cwd),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0)
    throw new Error(`${PLATFORM_SLUG} machine migrate failed with exit ${result.exitCode}`)
}

function applyImmediateUpdate(input: {
  target: string
  branch: string
  migration: string | null
  runGit: (cwd: string, args: string[]) => string
  migrate: (cwd: string) => void
}): void {
  const migration = input.migration
  if (!migration) {
    input.runGit(input.target, ['pull', '--ff-only', 'origin', input.branch])
    input.migrate(input.target)
    return
  }
  withSynchronousDatabaseForMigrationStep((database) => claimMigrationWindow(database, migration))
  try {
    input.runGit(input.target, ['pull', '--ff-only', 'origin', input.branch])
    input.migrate(input.target)
  } finally {
    withSynchronousDatabaseForMigrationStep((database) => clearMigrationWindow(database))
  }
}

export async function machineUpdateCommand(
  presentation: Presentation,
  deps: {
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    cwd?: string
    callerCwd?: string
    authorityRefusal?: () => string | null
    git?: (cwd: string, args: string[]) => string
    migrate?: (cwd: string) => void
    afterDrainPromoted?: () => void
    project?: (
      cwd: string,
      database: import('bun:sqlite').Database,
    ) => {
      name: string
      path: string
      settings: { trunk?: string }
    } | null
  } = {},
): Promise<void> {
  if (!existsSync(DB_PATH)) throw new Error(missingDatabaseMessage())
  if (!deps.authorityRefusal && DATABASE_RESOLUTION.method === 'BOTTEGA_ORCHESTRATOR_DB') {
    throw new Error(
      `refusing machine update through BOTTEGA_ORCHESTRATOR_DB; run it from the main checkout without the override`,
    )
  }
  const authorityRefusal = (deps.authorityRefusal ?? migrationAuthorityRefusal)()
  if (authorityRefusal) throw new Error(authorityRefusal)
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
  const branch = project.settings.trunk?.trim()
  if (!branch) throw new Error(`${project.name}: no registered landing branch`)
  const currentBranch = runGit(target, ['branch', '--show-current']) || '(detached HEAD)'
  if (currentBranch !== branch) {
    throw new Error(
      `refusing machine update: registered landing branch is ${branch}, but ${project.path} is on ${currentBranch}; ` +
        `check out ${branch} in ${project.path}`,
    )
  }
  if (!sameCheckout(callerCwd, target)) {
    presentation.log(`updating the ${PLATFORM_NAME} checkout at ${target}`)
  }
  runGit(target, ['fetch', 'origin', branch])
  const journal = incomingJournal(target, branch, runGit)
  const initial = withSynchronousDatabaseForMigrationStep((database) => {
    const local = migrationState(database)
    if (local.ahead) throw new Error(`store is ahead at migration ${local.ahead}`)
    const position = storeJournalPosition(database, journal)
    if (position.state === 'pending-not-found')
      throw new Error(`incoming journal does not contain pending migration ${position.migration}`)
    const activeDrain = migrationDrainForUpdate(database)
    return {
      activeDrain,
      decision: decideMigrationDrain({ journal, storeVersion: position.index }),
      pendingMigration: journal[position.index]?.tag ?? null,
    }
  })
  assertNoActiveDrain(initial.activeDrain)
  if (initial.decision.action === 'fence') {
    const migration = initial.decision.migration
    withSynchronousDatabaseForMigrationStep((database) =>
      setMigrationDrain(database, migration, 'draining'),
    )
    try {
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
      runGit(target, ['pull', '--ff-only', 'origin', branch])
      migrate(target)
    } finally {
      withSynchronousDatabaseForMigrationStep((database) => clearMigrationDrain(database))
    }
    return
  }
  applyImmediateUpdate({
    target,
    branch,
    migration: initial.pendingMigration,
    runGit,
    migrate,
  })
}
