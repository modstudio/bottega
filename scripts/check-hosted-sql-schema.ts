#!/usr/bin/env bun
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { applyRecordMigration, provisionRecordDatabase } from './check-record-migrations-apply.ts'
import { extractHostedSql, type HostedSqlSite } from './hosted-sql-schema.ts'

export type HostedSqlExemption = { file: string; fingerprint: string; reason: string }

const root = fileURLToPath(new URL('..', import.meta.url))
const migrationsFolder = join(root, 'shared', 'record', 'migrations')
const HOSTED_SQL_EXEMPTIONS: readonly HostedSqlExemption[] = [
  {
    file: 'orchestrator/src/record/record-projects.ts',
    fingerprint: '507a2869edf75557',
    reason: 'project rename selects a table from a closed hosted project-name table catalogue',
  },
  {
    file: 'hub/src/hosted-tasks.ts',
    fingerprint: 'b4b5ad2251c6ecca',
    reason: 'task parent lookup interpolates columns from the closed task relationship catalogue',
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
      `hosted SQL schema: prepared ${result.prepared} statements; skipped ${result.skipped} sites in ${seconds}s`,
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
