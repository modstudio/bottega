// concern: main-checkout database update
/** Adapts Git, the live store, and migration execution around the drain decision. */

import { Database } from 'bun:sqlite'
import { existsSync, realpathSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { RUN_WALL_TIME_CEILING_MS } from '../jobs/jobs.ts'
import { projectAt } from '../project/projects.ts'
import { migrationLeaseHoldingRuns } from '../run/migration-in-flight-runs.ts'
import {
  DATABASE_RESOLUTION,
  existingDatabaseMigrationRefusal,
  missingDatabaseMessage,
} from './database-location.ts'
import { DB_PATH } from './db.ts'
import {
  inFlightMigrationCompatibility,
  type MigrationJournalEntry,
  validatedMigrationJournalEntries,
} from './migration-compatibility.ts'
import {
  clearMigrationDrain,
  migrationDrainForUpdate,
  setMigrationDrain,
} from './migration-drain.ts'
import { migrationJournal, migrationState } from './migrations.ts'

const MIGRATION_DRAIN_POLL_MS = 1_000
/** One poll beyond the longest coordinator wall-time, so every admitted run can terminalise. */
const MIGRATION_DRAIN_WAIT_MAX_MS = RUN_WALL_TIME_CEILING_MS + MIGRATION_DRAIN_POLL_MS

type Presentation = { log(value: string): void }

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
    )
  }
  return result.stdout.toString().trim()
}

function incomingJournal(
  cwd: string,
  branch: string,
  runGit: (cwd: string, args: string[]) => string,
): MigrationJournalEntry[] {
  const source = runGit(cwd, [
    'show',
    `origin/${branch}:orchestrator/migrations/meta/_journal.json`,
  ])
  const parsed = JSON.parse(source) as { entries?: unknown[] }
  if (!Array.isArray(parsed.entries)) throw new Error('incoming migration journal has no entries')
  return validatedMigrationJournalEntries(parsed.entries)
}

function store<T>(action: (database: Database) => T): T {
  const database = new Database(DB_PATH, { readwrite: true, create: false })
  try {
    database.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
    return action(database)
  } finally {
    database.close()
  }
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
    const runs = store((database) => migrationLeaseHoldingRuns(database))
    if (runs.length === 0) return
    const report = runs.map((run) => `${run.name} (${run.status})`).join(', ')
    if (report !== lastReport) {
      input.presentation.log(`draining for migration ${input.migration}; waiting on ${report}`)
      lastReport = report
    }
    if (input.now() - started >= MIGRATION_DRAIN_WAIT_MAX_MS) {
      throw new Error(
        `migration drain wait bound reached; runs still in flight: ${runs.map((run) => `${run.name} (${run.status})`).join(', ')}; ` +
          `answer or stop them, then re-run ${PLATFORM_SLUG} machine update`,
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
    authorityRefusal?: () => string | null
    git?: (cwd: string, args: string[]) => string
    migrate?: (cwd: string) => void
    project?: (
      cwd: string,
      database: Database,
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
  const authorityRefusal = (deps.authorityRefusal ?? existingDatabaseMigrationRefusal)()
  if (authorityRefusal) throw new Error(authorityRefusal)
  const cwd = deps.cwd ?? process.cwd()
  const runGit = deps.git ?? git
  const migrate = deps.migrate ?? runMigration
  const project = store((database) => (deps.project ?? projectAt)(cwd, database))
  if (!project || realpathSync(cwd) !== realpathSync(project.path)) {
    throw new Error(
      'refusing machine update outside a registered main checkout; run it from the registered main checkout root',
    )
  }
  const branch = project.settings.trunk?.trim()
  if (!branch) throw new Error(`${project.name}: no registered landing branch`)
  runGit(cwd, ['fetch', 'origin', branch])
  const journal = incomingJournal(cwd, branch, runGit)
  const initial = store((database) => {
    const local = migrationState(database)
    if (local.ahead) throw new Error(`store is ahead at migration ${local.ahead}`)
    const firstPending = local.pending[0]
    const storeVersion = firstPending
      ? journal.findIndex((entry) => entry.tag === firstPending.tag)
      : migrationJournal().length
    if (storeVersion < 0) {
      throw new Error(`incoming journal does not contain pending migration ${firstPending!.tag}`)
    }
    const activeDrain = migrationDrainForUpdate(database)
    const compatibility =
      journal.length <= storeVersion
        ? null
        : inFlightMigrationCompatibility(journal, storeVersion, journal.length)
    return {
      activeDrain,
      storeVersion,
      compatibility,
    }
  })
  if (initial.activeDrain) {
    throw new Error(
      `migration drain is already active for ${initial.activeDrain.migration} ` +
        `(holder pid ${initial.activeDrain.pid}); wait for ${PLATFORM_SLUG} machine update to finish`,
    )
  }
  if (initial.compatibility === 'incompatible') {
    const migration = journal[initial.storeVersion]!.tag
    store((database) => setMigrationDrain(database, migration))
    try {
      const now = deps.now ?? Date.now
      const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
      await waitForDrain({
        migration,
        presentation,
        now,
        sleep,
      })
      runGit(cwd, ['pull', '--ff-only', 'origin', branch])
      migrate(cwd)
    } finally {
      store((database) => clearMigrationDrain(database))
    }
    return
  }
  runGit(cwd, ['pull', '--ff-only', 'origin', branch])
  migrate(cwd)
}
