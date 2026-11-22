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
  {
    pattern: /orchestrator\/src\/canon\/canon\.ts$/,
    reason: 'DEV-2584 PR 2 moves canon reads to the hosted record',
  },
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
    reason: 'DEV-2584 PR 2 moves workflow-floor reads to the hosted record',
  },
  {
    pattern: /orchestrator\/src\/canon\/canon-mirror-revisions\.ts$/,
    reason: 'DEV-2584 PR 2 moves canon reads to the hosted record',
  },
  {
    pattern: /orchestrator\/src\/identity\/doc-revision-identity\.ts$/,
    reason: 'local-install revision identifier lookup',
  },
]

const SQL_WITH_DOC_TABLE =
  /\b(?:from|join|into|update|table)\s+(?:(?:[a-z_][a-z0-9_]*|"[^"]+")\s*\.\s*)?["`\[]?(?:doc|doc_revision|doc_related_subject)\b/i
const LOCAL_SQL_IMPORT =
  /(?:from\s*['"]bun:sqlite['"]|import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*['"](?:\.\.?\/)+(?:database\/)?db\.ts['"])/s

function commentEnd(source: string, index: number): number | null {
  if (source[index] !== '/') return null
  if (source[index + 1] === '/') {
    const newline = source.indexOf('\n', index + 2)
    return newline < 0 ? source.length : newline
  }
  if (source[index + 1] === '*') {
    const close = source.indexOf('*/', index + 2)
    return close < 0 ? source.length : close + 1
  }
  return null
}

function stringLiteralAt(source: string, index: number): { end: number; value: string } | null {
  const quote = source[index]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  let value = ''
  for (index += 1; index < source.length; index += 1) {
    const character = source[index]!
    if (character === '\\') {
      value += character + (source[index + 1] ?? '')
      index += 1
    } else if (character === quote) {
      return { end: index, value }
    } else {
      value += character
    }
  }
  return { end: source.length, value }
}

function hasDocTableSql(source: string): boolean {
  if (!LOCAL_SQL_IMPORT.test(source)) return false
  for (let index = 0; index < source.length; index += 1) {
    const afterComment = commentEnd(source, index)
    if (afterComment !== null) {
      index = afterComment
      continue
    }
    const literal = stringLiteralAt(source, index)
    if (!literal) continue
    index = literal.end
    if (SQL_WITH_DOC_TABLE.test(literal.value)) return true
  }
  return false
}

export function docLocalSqlViolation(
  file: string,
  source: string,
  allowances: readonly DocLocalSqlAllowance[] = DOC_LOCAL_SQL_ALLOWANCES,
): string | null {
  if (file.endsWith('.test.ts') || file.endsWith('.fixture.ts') || !hasDocTableSql(source))
    return null
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
