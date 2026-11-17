#!/usr/bin/env bun
/** Question table access stays behind the question port and its persistence adapters. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const PRODUCTION_ROOT = 'orchestrator/src'
const QUESTION_SQL = /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+question\b/g
const EXACT_ADAPTERS = new Set([
  'orchestrator/src/question-store/question-store-sqlite.ts',
  'orchestrator/src/question-store/question-store-sqlite-reads.ts',
  'orchestrator/src/record/record-question-read.ts',
  'orchestrator/src/record/record-question-write.ts',
  'orchestrator/src/record/record-question-number.ts',
  // Machine-local pending delivery marker exemption.
  'orchestrator/src/run/question-delivery-pending.ts',
  // Migration validation and the generic local number allocator are persistence adapters.
  'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
  'orchestrator/src/database/entity-number.ts',
])

const allowed = (file: string): boolean =>
  file.startsWith('orchestrator/src/database/migration') ||
  file.endsWith('.fixture.ts') ||
  EXACT_ADAPTERS.has(file)

export function questionSqlViolations(source: string, file: string): string[] {
  if (allowed(file)) return []
  return [...source.matchAll(QUESTION_SQL)].map((match) => {
    const line = source.slice(0, match.index).split('\n').length
    return `${file}:${line}: use the question-store port`
  })
}

if (import.meta.main) {
  const violations: string[] = []
  for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(ROOT, PRODUCTION_ROOT) })) {
    if (relative.endsWith('.test.ts')) continue
    const file = join(PRODUCTION_ROOT, relative)
    violations.push(...questionSqlViolations(readFileSync(join(ROOT, file), 'utf8'), file))
  }
  for (const violation of violations) console.error(`${violation}: direct question SQL refused`)
  if (violations.length) process.exit(1)
  console.log('check-question-sql-sites: ok')
}
