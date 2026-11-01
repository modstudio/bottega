#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forcedRlsTables, forceRlsLiftViolations } from './record-migration-force-rls-lifts.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const migrationsFolder = join(root, 'shared', 'record', 'migrations')

const EXEMPTIONS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    '20260916153346_auth_model_force_and_grants',
    new Map([
      ['space', 'applied; the UPDATE took effect: the SET NOT NULL on slug that follows succeeded'],
    ]),
  ],
  [
    '20260918160359_dev_803_report_recipients',
    new Map([
      [
        'hub_report_subscription',
        'record_owner SELECT policies from 20260918114125 cover the delivery-relevant rows; user is not forced',
      ],
      [
        'hub_send',
        'record_owner SELECT policies from 20260918114125 cover the delivery-relevant rows; user is not forced',
      ],
    ]),
  ],
  [
    '20260924234500_dev_921_report_project_move',
    new Map([
      [
        'hub_report_subscription_project',
        'reads are $fragment$ text spliced into record_move_project_space, which runs at call time',
      ],
    ]),
  ],
  [
    '20260924180716_dev_906_doc_latest_revision',
    new Map([
      ['doc', 'no-op confirmed and repaired by DEV-917 (#495): 214 of 214 docs backfilled'],
      [
        'doc_revision',
        'no-op confirmed and repaired by DEV-917 (#495): 214 of 214 docs backfilled',
      ],
    ]),
  ],
  [
    '20261009132726_dev_1212_project_note_counter_backfill',
    new Map([
      ['hub_note', 'likely no-op; no duplicate numbers observed (889 notes, 0 dups, 2026-11-01)'],
      ['project', 'likely no-op; no duplicate numbers observed (889 notes, 0 dups, 2026-11-01)'],
    ]),
  ],
  [
    '20261101065127_dev_1989_lens_profile_selected_version_backfill',
    new Map([
      [
        'lens_profile',
        'applied before this check; resolved nothing because lens_profile stayed under FORCE RLS; DEV-1991 re-runs its rule',
      ],
      [
        'lens_profile_revision',
        'applied before this check; resolved nothing because lens_profile stayed under FORCE RLS; DEV-1991 re-runs its rule',
      ],
    ]),
  ],
])

type MigrationSource = { name: string; text: string }

function migrationSources(): MigrationSource[] {
  return readdirSync(migrationsFolder)
    .sort()
    .map((name) => ({
      name,
      text: readFileSync(join(migrationsFolder, name, 'migration.sql'), 'utf8'),
    }))
}

const migrations = migrationSources()
const forcedTables = new Set<string>()
for (const migration of migrations)
  for (const table of forcedRlsTables(migration.text)) forcedTables.add(table)

const failures: string[] = []
for (const migration of migrations) {
  const exemptions = EXEMPTIONS.get(migration.name) ?? new Map()
  const violations = forceRlsLiftViolations(
    migration.text,
    forcedTables,
    new Set(exemptions.keys()),
  )
  for (const violation of violations) failures.push(`${migration.name}: ${violation.table}`)
}

if (failures.length > 0) {
  console.error(
    `Record migrations read FORCE-RLS tables without lifting them:\n${failures.join('\n')}`,
  )
  process.exit(1)
}

console.log(`record migration FORCE-RLS lifts: ${migrations.length} checked`)
