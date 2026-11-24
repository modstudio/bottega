#!/usr/bin/env bun
/**
 * Static guard for SQL that can name hosted-only tables. Non-rendered SQL arguments are refused
 * broadly. A rendered template with an unresolved span is refused only when its static fragments
 * or referenced branches name a hosted-only table, or CREATE/DROP/ALTER has a dynamic target.
 * guardHostedTables remains the runtime backstop for SQL assembled dynamically.
 */
import { resolve } from 'node:path'
import {
  HOSTED_TABLES_WITHOUT_LOCAL_ACCESS,
  hostedTableInSql,
} from '../orchestrator/src/database/hosted-table-guard.ts'
import {
  hostedBoardLocalReadFailures,
  type HostedLocalReadHit,
  hostedLocalReadScan,
  hostedLocalSqlAllowedFileFailures,
  hostedLocalSqlExemptionReasonFailures,
  hostedLocalSqlSelectorFailures,
} from './hosted-local-read-report.ts'
import type {
  HostedSqlCannotJudgeSite,
  HostedSqlSite,
  HostedSqlUnresolvedSite,
} from './hosted-sql-schema.ts'
import {
  HOSTED_LOCAL_SQL_ALLOWED_FILES,
  type HostedLocalSqlAllowedFile,
} from './hosted-local-sql-allowlist.ts'
import { STATE_CLASSES, type StateClassDeclaration } from './identity-state-classes.ts'

type AllowedFile = HostedLocalSqlAllowedFile
type CannotJudgeSite = Pick<HostedSqlCannotJudgeSite, 'file' | 'fingerprint'> & { count: number }

export function reportOnlyAllowedFileBudgetFailures(
  hits: readonly HostedLocalReadHit[],
  allowedFiles: readonly AllowedFile[],
): string[] {
  return allowedFiles.flatMap((allowed) => {
    if (!allowed.reportOnly || allowed.expectedSites === undefined) return []
    const actual = new Set(
      hits
        .filter((hit) => allowed.pattern.test(hit.file))
        .map((hit) => `${hit.file}:${hit.line}`),
    ).size
    return actual === allowed.expectedSites
      ? []
      : [
          `${allowed.pattern}: report-only hosted SQL exemption expected ${allowed.expectedSites} sites but found ${actual}; inspect the file and update the exact-path budget only after verifying every site (${allowed.reason})`,
        ]
  })
}

// These dynamic table positions cannot be compared with the hosted-table list statically. This
// baseline is shrink-only and position-independent: a new occurrence and a listed occurrence that
// disappears both fail the check, while unrelated line movement does not.
const HOSTED_LOCAL_SQL_CANNOT_JUDGE: readonly CannotJudgeSite[] = [
  {
    file: 'orchestrator/src/database/applied-migration-compatibilities.ts',
    fingerprint: '7463683474865ece',
    count: 1,
  },
  { file: 'orchestrator/src/database/migrations.ts', fingerprint: 'c2bcd7e2f8124e6b', count: 1 },
  { file: 'orchestrator/src/database/migrations.ts', fingerprint: 'b73e4bb83e0e7c33', count: 1 },
  { file: 'orchestrator/src/database/migrations.ts', fingerprint: '27903a21e6eb16ab', count: 1 },
  { file: 'orchestrator/src/database/migrations.ts', fingerprint: 'c6a80514323db339', count: 1 },
  { file: 'orchestrator/src/database/migrations.ts', fingerprint: 'e2c360ab1bc139bf', count: 2 },
  { file: 'orchestrator/src/database/migrations.ts', fingerprint: '7d052d27daa537c2', count: 1 },
  { file: 'orchestrator/src/database/migrations.ts', fingerprint: '94c095d6cb4e312c', count: 1 },
  { file: 'orchestrator/src/database/migrations.ts', fingerprint: '63cd14a16f049ea3', count: 1 },
  { file: 'orchestrator/src/database/migrations.ts', fingerprint: '8e161a1a230eb845', count: 1 },
  { file: 'orchestrator/src/database/migrations.ts', fingerprint: '5554c8742578f04e', count: 1 },
  {
    file: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    fingerprint: '69dfb4ea9416b034',
    count: 1,
  },
  {
    file: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    fingerprint: '9888083730a7b2c3',
    count: 1,
  },
  {
    file: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    fingerprint: '8e0eda83ecfaeb2f',
    count: 1,
  },
  {
    file: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    fingerprint: 'bc8f9979f72410ab',
    count: 1,
  },
  {
    file: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    fingerprint: '2e50ddb469181ce3',
    count: 1,
  },
  {
    file: 'orchestrator/src/database/workflow-uuid-migration-preflight.ts',
    fingerprint: 'a241e17d4e8d8c3b',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '9639f51bc1550c03',
    count: 2,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '5c9fd129c3d4b73f',
    count: 2,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '1417efd6b354e702',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: 'c208ee3c943908a5',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '1d04a04d2cf3b706',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '850921d42645e4ca',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '791428279e160f65',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '7e6ac1f4dadcc333',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '7b875b5d8fa88c2c',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '14bec7f7b8a010b1',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: 'a1fc2a8a2b05e3e0',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: 'a3fb86bba61e3ccc',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '3df973fa87136ddd',
    count: 2,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '67c0ac3cb92b8316',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: 'aa5604c57f4b834b',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '7d8bf8bd0381d80d',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '6a33ebc6c88231dd',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-cache-workflow.ts',
    fingerprint: '3c8e68fbaeb5da95',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-push-catalogues.ts',
    fingerprint: '10e82ead1dfbc5ba',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-push-catalogues.ts',
    fingerprint: '8ce4908278702814',
    count: 1,
  },
  {
    file: 'orchestrator/src/record/record-push-catalogues.ts',
    fingerprint: '383022a650070478',
    count: 1,
  },
  { file: 'orchestrator/src/record/landing-outbox.ts', fingerprint: '543598fa794fcb6f', count: 1 },
  { file: 'orchestrator/src/project/project-rename.ts', fingerprint: '4362e5264bf0a218', count: 1 },
  { file: 'orchestrator/src/project/project-rename.ts', fingerprint: '746c46a002aa138f', count: 1 },
  { file: 'orchestrator/src/project/project-rename.ts', fingerprint: '3963bd7daacd1664', count: 1 },
  {
    file: 'orchestrator/src/project/project-reference-counts.ts',
    fingerprint: '068ed06fbe47a552',
    count: 1,
  },
  {
    file: 'orchestrator/src/project/project-purge-local.ts',
    fingerprint: '8c0233c605909e37',
    count: 1,
  },
  {
    file: 'orchestrator/src/project/project-purge-local.ts',
    fingerprint: '8e31a9d1da411112',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: 'ede535d9578d3797',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: 'a857a4b2b972163e',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: '798628156be850df',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: 'bdc9c668f3fa9c3d',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: 'b6b6a87e96f96f03',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: 'c077752476c0d1ce',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: 'd16fe45df2c87222',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: '850c6d2de7870630',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: 'f528f7d254e11096',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: '40373afeb1b3ba6a',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: '2eee5aa4ab3806ba',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: '49acf0551a9e5f5f',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: '3e309e8267319596',
    count: 1,
  },
  {
    file: 'orchestrator/src/workflow/versioned-lifecycle.ts',
    fingerprint: 'eaedfdbd33e1d716',
    count: 1,
  },
]

function cannotJudgeFailures(
  sites: readonly HostedSqlCannotJudgeSite[],
  baseline: readonly CannotJudgeSite[],
): string[] {
  const failures: string[] = []
  const key = (site: Pick<HostedSqlCannotJudgeSite, 'file' | 'fingerprint'>): string =>
    `${site.file}:${site.fingerprint}`
  const sitesByKey = new Map<string, HostedSqlCannotJudgeSite[]>()
  for (const site of sites) {
    const siteKey = key(site)
    sitesByKey.set(siteKey, [...(sitesByKey.get(siteKey) ?? []), site])
  }
  const baselineByKey = new Map(baseline.map((site) => [key(site), site]))
  for (const [siteKey, matchingSites] of sitesByKey) {
    const expected = baselineByKey.get(siteKey)?.count ?? 0
    for (const site of matchingSites.slice(expected))
      failures.push(
        `${site.file}:${site.line}: cannot judge interpolated SQL table ${site.expression}; use a static table name or add this occurrence to the shrink-only HOSTED_LOCAL_SQL_CANNOT_JUDGE baseline`,
      )
  }
  for (const [siteKey, baselineSite] of baselineByKey) {
    const actual = sitesByKey.get(siteKey)?.length ?? 0
    if (actual < baselineSite.count)
      failures.push(
        `${baselineSite.file}: stale cannot-judge SQL baseline entry for fingerprint ${baselineSite.fingerprint}; expected ${baselineSite.count} occurrences but found ${actual}`,
      )
  }
  return failures
}

function allowedFileBudgetFailures(
  allowedFiles: readonly AllowedFile[],
  uses: ReadonlyMap<number, number>,
): string[] {
  const failures = [
    ...hostedLocalSqlExemptionReasonFailures(allowedFiles),
    ...hostedLocalSqlAllowedFileFailures(allowedFiles),
  ]
  allowedFiles.forEach((allowed, index) => {
    const actual = uses.get(index) ?? 0
    if (allowed.expectedSites !== undefined && actual !== allowed.expectedSites)
      failures.push(
        `${allowed.pattern}: hosted-only SQL exemption expected ${allowed.expectedSites} sites but found ${actual}; update the exact-path budget only after verifying its selector (${allowed.reason})`,
      )
    else if (allowed.expectedSites === undefined && actual === 0)
      failures.push(
        `unused hosted-only SQL exemption ${allowed.pattern}: remove it from HOSTED_LOCAL_SQL_ALLOWED_FILES (${allowed.reason}: ${allowed.detail})`,
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

export function checkHostedLocalSql(root: string): {
  failures: string[]
  unresolved: number
  cannotJudge: number
} {
  const gateAllowedFiles = HOSTED_LOCAL_SQL_ALLOWED_FILES.filter(({ reportOnly }) => !reportOnly)
  const scan = hostedLocalReadScan(root)
  const { sites, unresolved, cannotJudge } = scan.gate
  return {
    failures: [
      ...scan.configurationFailures,
      ...reportOnlyAllowedFileBudgetFailures(scan.report.hits, HOSTED_LOCAL_SQL_ALLOWED_FILES),
      ...hostedBoardLocalReadFailures(scan.report.hits),
      ...hostedLocalSqlViolations({
        sites,
        unresolved,
        cannotJudge,
        cannotJudgeBaseline: HOSTED_LOCAL_SQL_CANNOT_JUDGE,
        tables: HOSTED_TABLES_WITHOUT_LOCAL_ACCESS,
        allowedFiles: gateAllowedFiles,
        stateClasses: STATE_CLASSES,
      }),
      ...hostedLocalSqlSelectorFailures(root, gateAllowedFiles),
    ],
    unresolved: unresolved.length,
    cannotJudge: cannotJudge.length,
  }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, '..')
  if (process.argv.includes('--report')) {
    const { formatHostedLocalReadReport, hostedLocalReadReport } = await import(
      './hosted-local-read-report.ts'
    )
    const report = hostedLocalReadReport(root)
    console.log(
      process.argv.includes('--json')
        ? JSON.stringify(report)
        : formatHostedLocalReadReport(report),
    )
    return
  }
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

if (import.meta.main) await main()
