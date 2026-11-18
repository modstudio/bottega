#!/usr/bin/env bun
/**
 * Static guard for SQL that can name hosted-only tables. Non-rendered SQL arguments are refused
 * broadly. A rendered template with an unresolved span is refused only when its static fragments
 * or referenced branches name a hosted-only table, or CREATE/DROP/ALTER has a dynamic target.
 * guardHostedTables remains the runtime backstop for SQL assembled dynamically.
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
  type HostedSqlCannotJudgeSite,
  type HostedSqlSite,
  type HostedSqlUnresolvedSite,
  productionTypeScriptFiles,
} from './hosted-sql-schema.ts'
import { STATE_CLASSES, type StateClassDeclaration } from './identity-state-classes.ts'

type AllowedFile = { pattern: RegExp; reason: string; expectedSites?: number }
type CannotJudgeSite = Pick<HostedSqlCannotJudgeSite, 'file' | 'line' | 'fingerprint'>

// These dynamic table positions cannot be compared with the hosted-table list statically. This
// baseline is shrink-only: a new site and a listed site that disappears both fail the check.
const HOSTED_LOCAL_SQL_CANNOT_JUDGE: readonly CannotJudgeSite[] = [
  {
    file: 'orchestrator/src/database/applied-migration-compatibilities.ts',
    line: 22,
    fingerprint: '7463683474865ece',
  },
  { file: 'orchestrator/src/database/migrations.ts', line: 172, fingerprint: 'c2bcd7e2f8124e6b' },
  { file: 'orchestrator/src/database/migrations.ts', line: 231, fingerprint: 'b73e4bb83e0e7c33' },
  { file: 'orchestrator/src/database/migrations.ts', line: 577, fingerprint: '27903a21e6eb16ab' },
  { file: 'orchestrator/src/database/migrations.ts', line: 594, fingerprint: 'c6a80514323db339' },
  { file: 'orchestrator/src/database/migrations.ts', line: 620, fingerprint: 'e2c360ab1bc139bf' },
  { file: 'orchestrator/src/database/migrations.ts', line: 661, fingerprint: 'e2c360ab1bc139bf' },
  { file: 'orchestrator/src/database/migrations.ts', line: 693, fingerprint: '7d052d27daa537c2' },
  { file: 'orchestrator/src/database/migrations.ts', line: 844, fingerprint: '94c095d6cb4e312c' },
  { file: 'orchestrator/src/database/migrations.ts', line: 849, fingerprint: '63cd14a16f049ea3' },
  { file: 'orchestrator/src/database/migrations.ts', line: 859, fingerprint: '8e161a1a230eb845' },
  { file: 'orchestrator/src/database/migrations.ts', line: 976, fingerprint: '5554c8742578f04e' },
  {
    file: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    line: 47,
    fingerprint: '69dfb4ea9416b034',
  },
  {
    file: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    line: 140,
    fingerprint: '9888083730a7b2c3',
  },
  {
    file: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    line: 156,
    fingerprint: '8e0eda83ecfaeb2f',
  },
  {
    file: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    line: 173,
    fingerprint: 'bc8f9979f72410ab',
  },
  {
    file: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    line: 181,
    fingerprint: '2e50ddb469181ce3',
  },
  {
    file: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    line: 195,
    fingerprint: 'a241e17d4e8d8c3b',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 137,
    fingerprint: '9639f51bc1550c03',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 143,
    fingerprint: '5c9fd129c3d4b73f',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 191,
    fingerprint: '1417efd6b354e702',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 198,
    fingerprint: 'c208ee3c943908a5',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 210,
    fingerprint: '1d04a04d2cf3b706',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 216,
    fingerprint: '850921d42645e4ca',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 231,
    fingerprint: '791428279e160f65',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 252,
    fingerprint: '7e6ac1f4dadcc333',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 257,
    fingerprint: '7b875b5d8fa88c2c',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 259,
    fingerprint: '14bec7f7b8a010b1',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 273,
    fingerprint: 'a1fc2a8a2b05e3e0',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 291,
    fingerprint: '9639f51bc1550c03',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 296,
    fingerprint: '5c9fd129c3d4b73f',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 303,
    fingerprint: 'a3fb86bba61e3ccc',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 324,
    fingerprint: '3df973fa87136ddd',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 330,
    fingerprint: '67c0ac3cb92b8316',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 336,
    fingerprint: '3df973fa87136ddd',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 350,
    fingerprint: 'aa5604c57f4b834b',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 355,
    fingerprint: '7d8bf8bd0381d80d',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 372,
    fingerprint: '6a33ebc6c88231dd',
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    line: 378,
    fingerprint: '3c8e68fbaeb5da95',
  },
  {
    file: 'orchestrator/src/record/record-push-catalogues.ts',
    line: 283,
    fingerprint: '10e82ead1dfbc5ba',
  },
  {
    file: 'orchestrator/src/record/record-push-catalogues.ts',
    line: 295,
    fingerprint: '8ce4908278702814',
  },
  {
    file: 'orchestrator/src/record/record-push-catalogues.ts',
    line: 315,
    fingerprint: '383022a650070478',
  },
  { file: 'orchestrator/src/record/landing-outbox.ts', line: 370, fingerprint: '543598fa794fcb6f' },
  { file: 'orchestrator/src/project/project-rename.ts', line: 41, fingerprint: '4362e5264bf0a218' },
  { file: 'orchestrator/src/project/project-rename.ts', line: 46, fingerprint: '746c46a002aa138f' },
  { file: 'orchestrator/src/project/project-rename.ts', line: 50, fingerprint: '3963bd7daacd1664' },
  {
    file: 'orchestrator/src/project/project-reference-counts.ts',
    line: 72,
    fingerprint: '068ed06fbe47a552',
  },
  {
    file: 'orchestrator/src/project/project-purge-local.ts',
    line: 269,
    fingerprint: '8c0233c605909e37',
  },
  {
    file: 'orchestrator/src/project/project-purge-local.ts',
    line: 277,
    fingerprint: '8e31a9d1da411112',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 46,
    fingerprint: 'ede535d9578d3797',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 77,
    fingerprint: 'a857a4b2b972163e',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 114,
    fingerprint: '798628156be850df',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 129,
    fingerprint: 'bdc9c668f3fa9c3d',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 164,
    fingerprint: 'b6b6a87e96f96f03',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 183,
    fingerprint: 'c077752476c0d1ce',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 190,
    fingerprint: 'd16fe45df2c87222',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 195,
    fingerprint: '850c6d2de7870630',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 222,
    fingerprint: 'f528f7d254e11096',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 226,
    fingerprint: '40373afeb1b3ba6a',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 230,
    fingerprint: '2eee5aa4ab3806ba',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 253,
    fingerprint: '49acf0551a9e5f5f',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 263,
    fingerprint: '3e309e8267319596',
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    line: 270,
    fingerprint: 'eaedfdbd33e1d716',
  },
]

export function hostedLocalRenderedSqlRisk(sql: string): boolean {
  return (
    hostedTableInSql(sql, HOSTED_TABLES_WITHOUT_LOCAL_ACCESS) !== null ||
    /^\s*(?:CREATE|DROP|ALTER)\b/i.test(sql)
  )
}

function cannotJudgeFailures(
  sites: readonly HostedSqlCannotJudgeSite[],
  baseline: readonly CannotJudgeSite[],
): string[] {
  const failures: string[] = []
  const key = (site: CannotJudgeSite): string => `${site.file}:${site.line}:${site.fingerprint}`
  const sitesByKey = new Map(sites.map((site) => [key(site), site]))
  const baselineByKey = new Map(baseline.map((site) => [key(site), site]))
  for (const [siteKey, site] of sitesByKey)
    if (!baselineByKey.has(siteKey))
      failures.push(
        `${site.file}:${site.line}: cannot judge interpolated SQL table ${site.expression}; use a static table name or add this site to the shrink-only HOSTED_LOCAL_SQL_CANNOT_JUDGE baseline`,
      )
  for (const [siteKey, site] of baselineByKey)
    if (!sitesByKey.has(siteKey))
      failures.push(
        `${site.file}:${site.line}: stale cannot-judge SQL baseline entry; remove it from HOSTED_LOCAL_SQL_CANNOT_JUDGE`,
      )
  return failures
}

function allowedFileBudgetFailures(
  allowedFiles: readonly AllowedFile[],
  uses: ReadonlyMap<number, number>,
): string[] {
  const failures: string[] = []
  allowedFiles.forEach((allowed, index) => {
    const actual = uses.get(index) ?? 0
    if (allowed.expectedSites !== undefined && actual !== allowed.expectedSites)
      failures.push(
        `${allowed.pattern}: hosted-only SQL exemption expected ${allowed.expectedSites} sites but found ${actual}; update the exact-path budget only after verifying its selector (${allowed.reason})`,
      )
    else if (allowed.expectedSites === undefined && actual === 0)
      failures.push(
        `unused hosted-only SQL exemption ${allowed.pattern}: remove it from HOSTED_LOCAL_SQL_ALLOWED_FILES (${allowed.reason})`,
      )
  })
  return failures
}

export function hostedLocalSqlViolations(input: {
  sites: readonly HostedSqlSite[]
  unresolved?: readonly HostedSqlUnresolvedSite[]
  cannotJudge?: readonly HostedSqlCannotJudgeSite[]
  cannotJudgeBaseline?: readonly CannotJudgeSite[]
  tables: readonly string[]
  allowedFiles: readonly AllowedFile[]
  stateClasses: readonly StateClassDeclaration[]
}): string[] {
  const failures: string[] = []
  const allowedFileUses = new Map<number, number>()
  const useAllowedFile = (index: number): void => {
    allowedFileUses.set(index, (allowedFileUses.get(index) ?? 0) + 1)
  }
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
      useAllowedFile(allowedIndex)
      continue
    }
    failures.push(
      `${site.file}:${site.line}: SQL names hosted-only table ${table}; route through the store selector, or declare the file local-only with its reason in HOSTED_LOCAL_SQL_ALLOWED_FILES`,
    )
  }
  for (const site of input.unresolved ?? []) {
    const allowedIndex = input.allowedFiles.findIndex(({ pattern }) => pattern.test(site.file))
    if (allowedIndex >= 0) {
      useAllowedFile(allowedIndex)
      continue
    }
    failures.push(
      `${site.file}:${site.line}: unresolved SQL ${site.expression}; make the SQL statically resolvable, route through the store selector, or declare the file local-only with its reason in HOSTED_LOCAL_SQL_ALLOWED_FILES`,
    )
  }
  failures.push(
    ...cannotJudgeFailures(input.cannotJudge ?? [], input.cannotJudgeBaseline ?? []),
    ...allowedFileBudgetFailures(input.allowedFiles, allowedFileUses),
  )
  return failures
}

function checkHostedLocalSql(root: string): {
  failures: string[]
  unresolved: number
  cannotJudge: number
} {
  const extracted = productionTypeScriptFiles(resolve(root, 'orchestrator')).map((file) => {
    const path = relative(root, file)
    return extractSqlFromSource({
      sourceText: readFileSync(file, 'utf8'),
      file: path,
      renderedUnresolvedRisk: hostedLocalRenderedSqlRisk,
    })
  })
  const sites = extracted.flatMap((value) => value.sites)
  const unresolved = extracted.flatMap((value) => value.unresolved)
  const cannotJudge = extracted.flatMap((value) => value.cannotJudge)
  return {
    failures: hostedLocalSqlViolations({
      sites,
      unresolved,
      cannotJudge,
      cannotJudgeBaseline: HOSTED_LOCAL_SQL_CANNOT_JUDGE,
      tables: HOSTED_TABLES_WITHOUT_LOCAL_ACCESS,
      allowedFiles: HOSTED_LOCAL_SQL_ALLOWED_FILES,
      stateClasses: STATE_CLASSES,
    }),
    unresolved: unresolved.length,
    cannotJudge: cannotJudge.length,
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..')
  const { failures, unresolved, cannotJudge } = checkHostedLocalSql(root)
  if (failures.length) {
    console.error(`hosted-only SQL reached undeclared local handles:\n${failures.join('\n')}`)
    process.exitCode = 1
  } else {
    console.log(
      `hosted-only SQL: all production sites are selector-gated or declared local-only; unresolved ${unresolved}; cannot-judge ${cannotJudge}`,
    )
  }
}
