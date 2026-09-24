#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeForcedRlsDml, type ForcedRlsDmlFinding } from './postgres-migration-rls.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const drizzleKit = join(root, 'node_modules', '.bin', 'drizzle-kit')
const migrationsFolder = join(root, 'shared', 'record', 'migrations')
const repairedMigration = '20260924202812_dev_918_doc_latest_revision_backfill'
const executeKeyword = 'EXECUTE'

type MigrationException = ForcedRlsDmlFinding & { migration: string; reasonText: string }

const APPLIED_MIGRATION_EXCEPTIONS: readonly MigrationException[] = [
  {
    migration: '20260915235059_run_record_force_and_operator',
    table: 'membership',
    operation: 'INSERT',
    reason: 'force-enabled',
    reasonText: 'already applied; app.space_id is bound to the inserted platform membership space',
  },
  {
    migration: '20260916153346_auth_model_force_and_grants',
    table: 'space',
    operation: 'UPDATE',
    reason: 'force-enabled',
    reasonText:
      'already applied; the following slug NOT NULL constraint guarantees the update succeeded',
  },
  {
    migration: '20260918161600_dev_803_send_recipient_append_only',
    table: '*',
    operation: 'EXECUTE',
    reason: 'dynamic-sql-force-enabled',
    reasonText: `${executeKeyword}s a rewritten CREATE OR REPLACE FUNCTION definition: DDL, writes no rows`,
  },
  {
    migration: '20260924180716_dev_906_doc_latest_revision',
    table: 'doc',
    operation: 'UPDATE',
    reason: 'force-enabled',
    reasonText: `already applied; repaired by ${repairedMigration}`,
  },
]

function run(args: string[]): string {
  const result = Bun.spawnSync([drizzleKit, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = result.stdout.toString().trim()
  const stderr = result.stderr.toString().trim()
  if (stdout) console.log(stdout)
  if (stderr) console.error(stderr)
  if (result.exitCode !== 0) process.exit(1)
  return stdout
}

function isException(migration: string, finding: ForcedRlsDmlFinding): boolean {
  return APPLIED_MIGRATION_EXCEPTIONS.some(
    (exception) =>
      exception.migration === migration &&
      exception.table === finding.table &&
      exception.operation === finding.operation &&
      exception.reason === finding.reason,
  )
}

function checkForcedRlsDml(): void {
  let forcedTables = new Set<string>()
  const failures: string[] = []
  for (const migration of readdirSync(migrationsFolder).sort()) {
    const path = join(migrationsFolder, migration, 'migration.sql')
    const analysis = analyzeForcedRlsDml(readFileSync(path, 'utf8'), forcedTables)
    for (const finding of analysis.findings) {
      if (!isException(migration, finding)) {
        failures.push(`${migration}: ${finding.operation} on ${finding.table} (${finding.reason})`)
      }
    }
    forcedTables = analysis.forcedTables
  }
  if (failures.length > 0) {
    console.error(
      `Postgres migrations perform DML without bracketing FORCE ROW LEVEL SECURITY:\n${failures.join('\n')}`,
    )
    process.exit(1)
  }
}

run(['check', '--config', 'shared/record/drizzle.config.ts', '--output', 'json'])
const explained = run([
  'generate',
  '--config',
  'shared/record/drizzle.config.ts',
  '--explain',
  '--output',
  'json',
])

let envelope: unknown
try {
  envelope = JSON.parse(explained)
} catch {
  console.error('drizzle-kit generate --explain did not return a JSON envelope')
  process.exit(1)
}
if (
  envelope === null ||
  typeof envelope !== 'object' ||
  !('status' in envelope) ||
  envelope.status !== 'no_changes'
) {
  console.error('Postgres schema has an ungenerated migration')
  process.exit(1)
}

checkForcedRlsDml()
