// concern: main-checkout database update
/** Adapts Git, the live store, and migration execution around the drain decision. */

import { existsSync } from 'node:fs'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { INSTALL_HOME_ENV, installRoot } from '../../../shared/install-root.ts'
import { realpathOrSpelled } from '../git/checkout-identity.ts'
import { git, targetGitEnvironment } from '../git/git-environment.ts'
import { RUN_WALL_TIME_CEILING_MS } from '../jobs/jobs.ts'
import { projectAt } from '../project/projects.ts'
import {
  formatMigrationInFlightRun,
  migrationInFlightRuns,
} from '../run/migration-in-flight-runs.ts'
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
import { ORCHESTRATOR_MIGRATION_JOURNAL_SOURCE } from './migration-journal-sources.ts'
import { migrationState, storeJournalPosition } from './migrations.ts'

const MIGRATION_DRAIN_POLL_MS = 1_000
/** Headroom after forced kill for worker terminalisation to release the run lease. */
const MIGRATION_TERMINALISATION_HEADROOM_MS = 5 * 60_000
/** Additional headroom for repository close-out to release its distinct close-out lease. */
const MIGRATION_CLOSE_OUT_HEADROOM_MS = 5 * 60_000
const MIGRATION_DRAIN_WAIT_MAX_MS =
  RUN_WALL_TIME_CEILING_MS + MIGRATION_TERMINALISATION_HEADROOM_MS + MIGRATION_CLOSE_OUT_HEADROOM_MS

type Presentation = { log(value: string): void }

function sameCheckout(left: string, right: string): boolean {
  return realpathOrSpelled(left) === realpathOrSpelled(right)
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

async function waitForDrain(input: {
  migration: string
  presentation: Presentation
  now: () => number
  sleep: (ms: number) => Promise<unknown>
}): Promise<void> {
  const started = input.now()
  let lastReport = ''
  for (;;) {
    const runs = withSynchronousDatabaseForMigrationStep((database) =>
      migrationInFlightRuns(database),
    )
    if (runs.length === 0) return
    const report = runs.map(formatMigrationInFlightRun).join(', ')
    if (report !== lastReport) {
      input.presentation.log(`draining for migration ${input.migration}; waiting on ${report}`)
      lastReport = report
    }
    if (input.now() - started >= MIGRATION_DRAIN_WAIT_MAX_MS) {
      throw new Error(
        `migration drain wait bound reached; runs still in flight: ${runs.map(formatMigrationInFlightRun).join(', ')}; ` +
          `answer or stop them, then re-run ${PLATFORM_SLUG} machine update; if the pulled store is already behind, ` +
          `run ${PLATFORM_SLUG} machine migrate --force-in-flight "<reason>" --from-operator`,
      )
    }
    await input.sleep(MIGRATION_DRAIN_POLL_MS)
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
  const project = withSynchronousDatabaseForMigrationStep((database) =>
    (deps.project ?? projectAt)(target, database),
  )
  if (!project || !sameCheckout(target, project.path)) {
    const binary = project
      ? `${project.path}/bin/${PLATFORM_SLUG}`
      : `the registered main checkout's bin/${PLATFORM_SLUG}`
    throw new Error(
      `refusing machine update: this installation's root ${target} is not a registered main checkout; run ${binary} machine update, or unset ${INSTALL_HOME_ENV} if it points elsewhere`,
    )
  }
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
    }
  })
  if (initial.activeDrain) {
    throw new Error(
      `migration drain is already active for ${initial.activeDrain.migration} ` +
        `(holder pid ${initial.activeDrain.pid}); wait for ${PLATFORM_SLUG} machine update to finish`,
    )
  }
  if (initial.decision.action === 'fence') {
    const migration = initial.decision.migration
    withSynchronousDatabaseForMigrationStep((database) =>
      setMigrationDrain(database, migration, 'draining'),
    )
    try {
      const now = deps.now ?? Date.now
      const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
      for (;;) {
        await waitForDrain({ migration, presentation, now, sleep })
        withSynchronousDatabaseForMigrationStep((database) =>
          setMigrationDrainPhase(database, 'migrating'),
        )
        deps.afterDrainPromoted?.()
        const raced = withSynchronousDatabaseForMigrationStep((database) =>
          migrationInFlightRuns(database),
        )
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
  runGit(target, ['pull', '--ff-only', 'origin', branch])
  migrate(target)
}
