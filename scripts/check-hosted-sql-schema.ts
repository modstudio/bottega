#!/usr/bin/env bun
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { applyRecordMigration, provisionRecordDatabase } from './check-record-migrations-apply.ts'
import { extractHostedSql, type HostedSqlSite } from './hosted-sql-schema.ts'

export type HostedSqlExemption = {
  file: string
  fingerprint: string
  reason: string
}

const root = fileURLToPath(new URL('..', import.meta.url))
const migrationsFolder = join(root, 'shared', 'record', 'migrations')
const HOSTED_SQL_EXEMPTIONS: readonly HostedSqlExemption[] = [
  {
    file: 'orchestrator/src/record/record-projects.ts',
    fingerprint: 'b587c872a88a0718',
    reason: 'project rename selects a table from a closed hosted project-name table catalogue',
  },
  {
    file: 'hub/src/hosted-task-prune.ts',
    fingerprint: 'ca0b14628c1ef236',
    reason:
      'child pruning interpolates a table and columns from the closed task relationship catalogue',
  },
  {
    file: 'hub/src/hosted-task-prune.ts',
    fingerprint: '47f687d564ea3eb9',
    reason:
      'incoming-link cleanup interpolates a table and column from the closed task relationship catalogue',
  },
  {
    file: 'hub/src/hosted-changes.ts',
    fingerprint: '7d64a7aca0eb15b7',
    reason: 'change reader interpolates one of its reviewed hosted change tables',
  },
  {
    file: 'hub/src/hosted-task-reference.ts',
    fingerprint: 'e1f448bef767bc42',
    reason:
      'task reference repair interpolates a table and columns from the closed relationship catalogue',
  },
  {
    file: 'hub/src/hosted-identity-set.ts',
    fingerprint: 'fca91eb46bfb1869',
    reason:
      'identity paging interpolates one validated hosted change table and optional soft-delete clause',
  },
  {
    file: 'orchestrator/src/postgres/postgres-migrate-hosted-project-cleanup.test.ts',
    fingerprint: '9e74f47839a85e47',
    reason: 'cleanup collision proof conditionally appends one complete destination document row',
  },
  {
    file: 'orchestrator/src/postgres/postgres-migrate-rls.test.ts',
    fingerprint: '72ddb5876469b406',
    reason: 'RLS seed composes the reviewed Better Auth invitation fixture statements',
  },
  {
    file: 'orchestrator/src/postgres/postgres-migrate-rls.test.ts',
    fingerprint: 'f491f4da8f4b51e9',
    reason: 'RLS catalogue proof selects from each table discovered from the hosted schema',
  },
  {
    file: 'orchestrator/src/postgres/postgres-migrate-recipients.test.ts',
    fingerprint: 'e472f32ad619d0ce',
    reason:
      'recipient migration proof deliberately seeds the hosted schema before recipient columns were normalized',
  },
  {
    file: 'orchestrator/test/postgres-docs-proof.ts',
    fingerprint: '344d6755bb2d1df8',
    reason: 'document isolation proof counts each table in its closed document-table catalogue',
  },
  ...[
    '45039a0883411f81',
    '5465612598762f90',
    'c9ea661c53d44677',
    '603c114b0c9233d9',
    'df723fc4cb3f43eb',
    '36ed9e6ed1809a5e',
  ].map((fingerprint) => ({
    file: 'orchestrator/test/postgres-config-proof.ts',
    fingerprint,
    reason: 'configuration isolation proof selects from a table in its closed hosted catalogue',
  })),
  {
    file: 'orchestrator/test/fixtures/postgres-rls.ts',
    fingerprint: '5fc79bc7410f82a4',
    reason: 'shared actor helper appends the caller-provided hosted statement after session setup',
  },
  {
    file: 'orchestrator/test/fixtures/postgres-rls.ts',
    fingerprint: '5627c6304ce54fec',
    reason: 'shared multi-space actor helper appends the caller-provided hosted statement',
  },
  ...['a6c71c665e60a688', '79101d349f0a2d8d'].map((fingerprint) => ({
    file: 'orchestrator/src/postgres/postgres-migrate-jsonb-binding.test.ts',
    fingerprint,
    reason: 'JSONB proof interpolates UUID values from the revisions created earlier in the test',
  })),
  ...['f3a43598cf6214e1', '699e03b5f4b6d87f', '33db9bcc8aa8f7c7'].map((fingerprint) => ({
    file: 'orchestrator/test/postgres-board-proof.ts',
    fingerprint,
    reason: 'board proof inserts rows composed by the closed messageValues fixture helper',
  })),
  {
    file: 'orchestrator/test/postgres-score-proof.ts',
    fingerprint: '7b4a9fb4a8d252f5',
    reason: 'score proof selects one of two reviewed projection expressions at its call sites',
  },
]

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function prepareSite(database: PGlite, site: HostedSqlSite, number: number): Promise<void> {
  const name = `hosted_sql_schema_${number}`
  await database.exec(`PREPARE ${name} AS ${site.sql}`)
  await database.exec(`DEALLOCATE ${name}`)
}

export async function checkHostedSqlSchema(input: {
  database: PGlite
  sites: HostedSqlSite[]
  unresolved?: HostedSqlSite[]
  exemptions?: readonly HostedSqlExemption[]
}): Promise<{ prepared: number; skipped: number }> {
  const exemptions = input.exemptions ?? []
  const exemptionByKey = new Map(
    exemptions.map((item) => [`${item.file}#${item.fingerprint}`, item]),
  )
  const unused = new Set(exemptionByKey.keys())
  const failures: string[] = []
  let prepared = 0
  let skipped = 0
  for (const site of [...input.sites, ...(input.unresolved ?? [])]) {
    const key = `${site.file}#${site.fingerprint}`
    if (exemptionByKey.has(key)) {
      unused.delete(key)
      skipped += 1
      continue
    }
    if ((input.unresolved ?? []).includes(site)) {
      failures.push(`${site.file}:${site.line} unresolved hosted SQL [${site.fingerprint}]`)
      continue
    }
    try {
      await prepareSite(input.database, site, prepared)
      prepared += 1
    } catch (error) {
      failures.push(`${site.file}:${site.line}: ${errorMessage(error)} [${site.fingerprint}]`)
    }
  }
  for (const key of unused) failures.push(`stale hosted SQL exemption: ${key}`)
  if (failures.length)
    throw new Error(
      `Hosted SQL does not prepare against the current schema:\n${failures.join('\n')}`,
    )
  return { prepared, skipped }
}

async function main(): Promise<void> {
  const startedAt = performance.now()
  const database = new PGlite()
  await database.waitReady
  try {
    await provisionRecordDatabase(database)
    const migrations = readMigrationFiles({ migrationsFolder })
    await database.transaction(async (transaction) => {
      for (const migration of migrations) await applyRecordMigration(transaction, migration)
    })
    const extracted = extractHostedSql(root)
    const result = await checkHostedSqlSchema({
      database,
      sites: extracted.sites,
      unresolved: extracted.unresolved,
      exemptions: HOSTED_SQL_EXEMPTIONS,
    })
    const seconds = ((performance.now() - startedAt) / 1_000).toFixed(2)
    console.log(
      `hosted SQL schema: prepared ${result.prepared} statements; unresolved ${extracted.unresolved.length}; exempt ${result.skipped} in ${seconds}s`,
    )
  } finally {
    await database.close()
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(errorMessage(error))
    process.exitCode = 1
  }
}
