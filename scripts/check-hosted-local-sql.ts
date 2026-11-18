#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import {
  HOSTED_LOCAL_SQL_ALLOWED_FILES,
  HOSTED_TABLES_WITHOUT_LOCAL_ACCESS,
  hostedTableInSql,
} from '../orchestrator/src/database/hosted-table-guard.ts'
import { extractSqlFromSource, type HostedSqlSite } from './hosted-sql-schema.ts'
import { STATE_CLASSES, type StateClassDeclaration } from './identity-state-classes.ts'

type AllowedFile = { pattern: RegExp; reason: string }

export function hostedLocalSqlViolations(input: {
  sites: readonly HostedSqlSite[]
  tables: readonly string[]
  allowedFiles: readonly AllowedFile[]
  stateClasses: readonly StateClassDeclaration[]
}): string[] {
  const failures: string[] = []
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
    if (!table || input.allowedFiles.some(({ pattern }) => pattern.test(site.file))) continue
    failures.push(
      `${site.file}:${site.line}: SQL names hosted-only table ${table}; route through the store selector, or declare the file local-only with its reason in HOSTED_LOCAL_SQL_ALLOWED_FILES`,
    )
  }
  return failures
}

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

function checkHostedLocalSql(root: string): string[] {
  const sites = productionTypeScriptFiles(resolve(root, 'orchestrator')).flatMap((file) => {
    const path = relative(root, file)
    return extractSqlFromSource({ sourceText: readFileSync(file, 'utf8'), file: path }).sites
  })
  return hostedLocalSqlViolations({
    sites,
    tables: HOSTED_TABLES_WITHOUT_LOCAL_ACCESS,
    allowedFiles: HOSTED_LOCAL_SQL_ALLOWED_FILES,
    stateClasses: STATE_CLASSES,
  })
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..')
  const failures = checkHostedLocalSql(root)
  if (failures.length) {
    console.error(`hosted-only SQL reached undeclared local handles:\n${failures.join('\n')}`)
    process.exitCode = 1
  } else {
    console.log('hosted-only SQL: all production sites are selector-gated or declared local-only')
  }
}
