#!/usr/bin/env bun
/**
 * Static guard for SQL that can name hosted-only tables. Non-literal SQL is refused when it can be
 * identified; guardHostedTables remains the runtime backstop for SQL assembled dynamically.
 */
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import {
  HOSTED_LOCAL_SQL_ALLOWED_FILES,
  HOSTED_TABLES_WITHOUT_LOCAL_ACCESS,
  hostedTableInSql,
} from '../orchestrator/src/database/hosted-table-guard.ts'
import {
  extractSqlFromSource,
  productionTypeScriptFiles,
  type HostedSqlSite,
  type HostedSqlUnresolvedSite,
} from './hosted-sql-schema.ts'
import { STATE_CLASSES, type StateClassDeclaration } from './identity-state-classes.ts'

type AllowedFile = { pattern: RegExp; reason: string }

export function hostedLocalSqlViolations(input: {
  sites: readonly HostedSqlSite[]
  unresolved?: readonly HostedSqlUnresolvedSite[]
  tables: readonly string[]
  allowedFiles: readonly AllowedFile[]
  stateClasses: readonly StateClassDeclaration[]
}): string[] {
  const failures: string[] = []
  const usedAllowedFiles = new Set<number>()
  const hosted = new Set(
    input.stateClasses.flatMap((item) =>
      'table' in item && item.store === 'orchestrator' && item.class === 'hosted'
        ? [item.table]
        : [],
    ),
  )
  for (const table of input.tables)
    if (!hosted.has(table))
      failures.push(
        `${table}: guarded hosted-only table is not declared hosted in the identity-state inventory; declare it hosted before guarding local access`,
      )
  for (const site of input.sites) {
    const table = hostedTableInSql(site.sql, input.tables)
    if (!table) continue
    const allowedIndex = input.allowedFiles.findIndex(({ pattern }) => pattern.test(site.file))
    if (allowedIndex >= 0) {
      usedAllowedFiles.add(allowedIndex)
      continue
    }
    failures.push(
      `${site.file}:${site.line}: SQL names hosted-only table ${table}; route through the store selector, or declare the file local-only with its reason in HOSTED_LOCAL_SQL_ALLOWED_FILES`,
    )
  }
  for (const site of input.unresolved ?? []) {
    const allowedIndex = input.allowedFiles.findIndex(({ pattern }) => pattern.test(site.file))
    if (allowedIndex >= 0) {
      usedAllowedFiles.add(allowedIndex)
      continue
    }
    failures.push(
      `${site.file}:${site.line}: unresolved SQL ${site.expression}; make the SQL statically resolvable, route through the store selector, or declare the file local-only with its reason in HOSTED_LOCAL_SQL_ALLOWED_FILES`,
    )
  }
  input.allowedFiles.forEach((allowed, index) => {
    if (!usedAllowedFiles.has(index))
      failures.push(
        `unused hosted-only SQL exemption ${allowed.pattern}: remove it from HOSTED_LOCAL_SQL_ALLOWED_FILES (${allowed.reason})`,
      )
  })
  return failures
}

function checkHostedLocalSql(root: string): { failures: string[]; unresolved: number } {
  const extracted = productionTypeScriptFiles(resolve(root, 'orchestrator')).map((file) => {
    const path = relative(root, file)
    return extractSqlFromSource({ sourceText: readFileSync(file, 'utf8'), file: path })
  })
  const sites = extracted.flatMap((value) => value.sites)
  const unresolved = extracted.flatMap((value) => value.unresolved)
  return {
    failures: hostedLocalSqlViolations({
      sites,
      unresolved,
      tables: HOSTED_TABLES_WITHOUT_LOCAL_ACCESS,
      allowedFiles: HOSTED_LOCAL_SQL_ALLOWED_FILES,
      stateClasses: STATE_CLASSES,
    }),
    unresolved: unresolved.length,
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..')
  const { failures, unresolved } = checkHostedLocalSql(root)
  if (failures.length) {
    console.error(`hosted-only SQL reached undeclared local handles:\n${failures.join('\n')}`)
    process.exitCode = 1
  } else {
    console.log(
      `hosted-only SQL: all production sites are selector-gated or declared local-only; unresolved ${unresolved}`,
    )
  }
}
