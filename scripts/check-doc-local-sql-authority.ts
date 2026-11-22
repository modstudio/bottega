#!/usr/bin/env bun
/** Refuses document-table SQL outside declared local-store and mirror paths. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Glob } from 'bun'

export type DocLocalSqlAllowance = { pattern: RegExp; reason: string }

export const DOC_LOCAL_SQL_ALLOWANCES: readonly DocLocalSqlAllowance[] = [
  { pattern: /orchestrator\/src\/doc\/doc-read-store\.ts$/, reason: 'declared local doc store' },
  {
    pattern: /orchestrator\/src\/doc\/doc-revision-store\.ts$/,
    reason: 'declared local revision store',
  },
  { pattern: /orchestrator\/src\/doc\/local-doc-write\.ts$/, reason: 'local doc write path' },
  {
    pattern: /orchestrator\/src\/doc\/local-doc-tree-service\.ts$/,
    reason: 'local doc tree write path',
  },
  { pattern: /orchestrator\/src\/doc\/docs\.ts$/, reason: 'local-install document branches' },
  {
    pattern: /orchestrator\/src\/doc\/canon-import\.ts$/,
    reason: 'hosted canon mirror write-back',
  },
  { pattern: /orchestrator\/src\/canon\/canon\.ts$/, reason: 'temporary local canon read path' },
  {
    pattern: /orchestrator\/src\/record\/record-cache[^/]*\.ts$/,
    reason: 'document mirror engine',
  },
  {
    pattern: /orchestrator\/src\/record\/record-push-docs\.ts$/,
    reason: 'document mirror push engine',
  },
  { pattern: /orchestrator\/src\/database\/migrations\.ts$/, reason: 'local schema migrations' },
  { pattern: /orchestrator\/src\/porting\/porting-import\.ts$/, reason: 'local store import' },
  {
    pattern: /orchestrator\/src\/database\/entity-number\.ts$/,
    reason: 'local entity number allocator',
  },
  {
    pattern: /orchestrator\/src\/doc\/local-doc-order\.ts$/,
    reason: 'local-install branch of reorder',
  },
  {
    pattern: /orchestrator\/src\/doc\/doc-reference-read\.ts$/,
    reason: 'temporary local reference read path',
  },
  {
    pattern: /orchestrator\/src\/canon\/canon-mirror-revisions\.ts$/,
    reason: 'temporary local canon mirror revision path',
  },
]

const SQL_WITH_DOC_TABLE =
  /\b(?:select|insert|update|delete|from|join|create|drop|alter)\b[\s\S]*\b(?:doc|doc_revision|doc_related_subject)\b/i
const LOCAL_SQL_CALL =
  /(?:\bdb\(\)|\bdatabase|\blocal)\s*\.\s*(?:query|exec)\s*\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)/gs

function hasDocTableSql(source: string): boolean {
  return [...source.matchAll(LOCAL_SQL_CALL)].some((match) =>
    SQL_WITH_DOC_TABLE.test(match[1] ?? match[2] ?? match[3] ?? ''),
  )
}

export function docLocalSqlViolation(
  file: string,
  source: string,
  allowances: readonly DocLocalSqlAllowance[] = DOC_LOCAL_SQL_ALLOWANCES,
): string | null {
  if (file.endsWith('.test.ts') || !hasDocTableSql(source)) return null
  if (allowances.some(({ pattern }) => pattern.test(file))) return null
  return `${file}: document-table SQL is outside a declared local-store or mirror path`
}

async function checkDocLocalSqlAuthority(root = resolve(import.meta.dir, '..')): Promise<string[]> {
  const failures: string[] = []
  for await (const file of new Glob('orchestrator/src/**/*.ts').scan({ cwd: root })) {
    const violation = docLocalSqlViolation(file, readFileSync(resolve(root, file), 'utf8'))
    if (violation) failures.push(violation)
  }
  return failures.sort()
}

if (import.meta.main) {
  const started = performance.now()
  const failures = await checkDocLocalSqlAuthority()
  for (const failure of failures) console.error(failure)
  console.log(`document local SQL authority: ${(performance.now() - started).toFixed(1)} ms`)
  if (failures.length) process.exitCode = 1
}
