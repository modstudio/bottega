#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const RECORD_POOL_FILE = 'orchestrator/src/record/record-pool.ts'
const NEW_SQL = /new\s+SQL\s*\(/g
const TEST_FILE = /(?:^|\/)(?:test|tests)\/|(?:^|\/)(?:test-[^/]+|[^/]+\.test)\.ts$/

const RECORD_SQL_POOL_EXEMPTIONS = new Map<string, { sites: number; reason: string }>([
  [
    'orchestrator/src/postgres/postgres-migrate.ts',
    { sites: 3, reason: 'owner-role migration clients are bounded to migration execution' },
  ],
  [
    'orchestrator/src/record/record-board-wake.ts',
    { sites: 1, reason: 'the LISTEN client is long-lived and owns its subscription session' },
  ],
  [
    'orchestrator/src/record/record-space-move.ts',
    {
      sites: 1,
      reason: 'record_move_project_space leaves session-lifetime temp tables on its connection',
    },
  ],
  [
    'orchestrator/src/record/record-auth.ts',
    { sites: 2, reason: 'Better Auth owns its dedicated one-connection clients' },
  ],
])

export type RecordSqlSource = { file: string; source: string }

export function recordSqlPoolViolations(files: readonly RecordSqlSource[]): string[] {
  const violations: string[] = []
  for (const { file, source } of files) {
    if (file === RECORD_POOL_FILE || TEST_FILE.test(file)) continue
    const exemption = RECORD_SQL_POOL_EXEMPTIONS.get(file)
    const sites = [...source.matchAll(NEW_SQL)]
    for (const site of sites.slice(exemption?.sites ?? 0)) {
      const line = source.slice(0, site.index).split('\n').length
      violations.push(
        `${file}:${line}: new SQL() is not allowed here; use recordPool(url) from orchestrator/src/record/record-pool.ts`,
      )
    }
  }
  return violations
}

function productionSources(): RecordSqlSource[] {
  const sources: RecordSqlSource[] = []
  for (const directory of ['orchestrator/src/record', 'orchestrator/src/postgres']) {
    for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(ROOT, directory) })) {
      const file = join(directory, relative)
      sources.push({ file, source: readFileSync(join(ROOT, file), 'utf8') })
    }
  }
  return sources
}

if (import.meta.main) {
  const violations = recordSqlPoolViolations(productionSources())
  for (const violation of violations) console.error(violation)
  if (violations.length) process.exit(1)
  console.log('check-record-sql-pool: ok')
}
