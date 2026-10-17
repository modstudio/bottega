import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { applyMigrations as applyHubMigrations } from '../hub/src/migrations.ts'
import { applyMigrations as applyOrchestratorMigrations } from '../orchestrator/src/database/migrations.ts'

type Concern = {
  name: 'orchestrator' | 'hub'
  root: string
  migrate(database: Database): unknown
}
type SqlSite = { file: string; line: number; sql: string; interpolated: boolean }

/** Sites whose SQL shape depends on runtime identifiers or whole clauses and cannot be neutralized. */
const DYNAMIC_SQL_SITES = [
  'orchestrator/src/database/migrations.ts:147',
  'orchestrator/src/database/migrations.ts:183',
  'orchestrator/src/database/migrations.ts:327',
  'orchestrator/src/database/migrations.ts:345',
  'orchestrator/src/database/migrations.ts:368',
  'orchestrator/src/database/migrations.ts:375',
  'orchestrator/src/database/migrations.ts:583',
  'orchestrator/src/monitor/monitor-conditions.ts:386',
  'orchestrator/src/branch/branch-settlement.ts:33',
  'orchestrator/src/record/landing-outbox.ts:270',
  'orchestrator/src/evidence/evidence-query.ts:191',
  'orchestrator/src/evidence/evidence-query.ts:240',
  'orchestrator/src/route/routing-backtest.ts:269',
  'orchestrator/src/route/route.ts:439',
  'orchestrator/src/route/route.ts:498',
  'orchestrator/src/route/route.ts:530',
  'orchestrator/src/board/board-push-service.ts:54',
  'orchestrator/src/resources/resource-ownership.ts:44',
  'orchestrator/src/project/project-rename.ts:38',
  'orchestrator/src/project/project-rename.ts:43',
  'orchestrator/src/project/project-rename.ts:47',
  'orchestrator/src/project/project-reference-counts.ts:43',
  'orchestrator/src/lens/lenses.ts:238',
  'orchestrator/src/score/duel.ts:162',
  'orchestrator/src/score/duel.ts:194',
  'orchestrator/src/cleanup/cleanup.ts:119',
  'orchestrator/src/review/review-triage.ts:110',
  'orchestrator/src/review/review.ts:174',
  'orchestrator/src/review/review-calibration.ts:113',
  'orchestrator/src/review/review-calibration.ts:158',
  'orchestrator/src/review/review-calibration.ts:170',
  'orchestrator/src/review/review-calibration.ts:184',
  'orchestrator/src/review/review-calibration.ts:191',
  'orchestrator/src/review/review-calibration.ts:197',
  'orchestrator/src/review/review-calibration.ts:208',
  'orchestrator/src/review/review-calibration.ts:241',
  'orchestrator/src/workflow/versioned-lifecycle.ts:45',
  'orchestrator/src/workflow/versioned-lifecycle.ts:55',
  'orchestrator/src/workflow/versioned-lifecycle.ts:68',
  'orchestrator/src/workflow/versioned-lifecycle.ts:86',
  'orchestrator/src/workflow/versioned-lifecycle.ts:103',
  'orchestrator/src/workflow/versioned-lifecycle.ts:121',
  'orchestrator/src/workflow/versioned-lifecycle.ts:127',
  'orchestrator/src/workflow/versioned-lifecycle.ts:132',
  'orchestrator/src/workflow/versioned-lifecycle.ts:159',
  'orchestrator/src/workflow/versioned-lifecycle.ts:163',
  'orchestrator/src/workflow/versioned-lifecycle.ts:167',
  'orchestrator/src/workflow/versioned-lifecycle.ts:190',
  'orchestrator/src/workflow/versioned-lifecycle.ts:200',
  'orchestrator/src/workflow/versioned-lifecycle.ts:207',
  'orchestrator/src/workflow/workflows.ts:294',
  'orchestrator/src/doc/doc-read-store.ts:287',
  'orchestrator/src/doc/doc-read-store.ts:401',
  'orchestrator/src/run/ruling-list.ts:25',
  'orchestrator/src/run/run-inbox.ts:194',
  'orchestrator/src/run/run-inbox.ts:406',
  'orchestrator/src/run/run-inbox.ts:485',
  'orchestrator/src/run/live-run-member.ts:40',
  'orchestrator/src/reclaim/reclaim.ts:53',
  'orchestrator/src/porting/porting.ts:167',
  'orchestrator/src/porting/porting.ts:253',
  'hub/src/hosted-change-cache.ts:339',
  'hub/src/hosted-change-cache.ts:360',
  'hub/src/note.ts:337',
  'hub/src/task-cache.ts:25',
  'hub/src/task-cache.ts:30',
  'hub/src/task-cache.ts:310',
  'hub/src/task-cache.ts:321',
  'hub/src/task-cache.ts:340',
  'hub/src/migrations.ts:150',
  'hub/src/migrations.ts:267',
  'hub/src/migrations.ts:285',
  'hub/src/migrations.ts:308',
  'hub/src/migrations.ts:315',
  'hub/src/migrations.ts:599',
  'hub/src/pending-hosted-edit.ts:91',
  'hub/src/pending-hosted-edit.ts:168',
  'hub/src/project-record-id.ts:37',
  'hub/src/install-binding.ts:10',
  'hub/src/install-binding.ts:26',
  'hub/src/task.ts:440',
] as const

const SQL_PREPARE_SKIPS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    DYNAMIC_SQL_SITES.map((site) => [site, 'runtime identifiers or complete SQL clauses']),
  ),
  'orchestrator/src/project/project-record-identity.ts:133':
    'pre-0117 identity backfill, reached only while the legacy project.id column exists',
}

const root = resolve(import.meta.dir, '..')
const SQL_START = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|PRAGMA|CREATE|DROP|ALTER)\b/i

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'postgres') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

function literalSql(node: ts.Expression): { sql: string; interpolated: boolean } | null {
  if (ts.isStringLiteralLike(node)) return { sql: node.text, interpolated: false }
  if (!ts.isTemplateExpression(node)) return null
  return {
    sql: `${node.head.text}${node.templateSpans.map((span) => `NULL${span.literal.text}`).join('')}`,
    interpolated: true,
  }
}

function sqlSites(concern: Concern): SqlSite[] {
  const sites: SqlSite[] = []
  for (const file of productionTypeScriptFiles(concern.root)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['query', 'prepare'].includes(node.expression.name.text) &&
        node.arguments[0]
      ) {
        const literal = literalSql(node.arguments[0])
        if (literal && SQL_START.test(literal.sql)) {
          const line =
            source.getLineAndCharacterOfPosition(node.arguments[0].getStart(source)).line + 1
          sites.push({ file: relative(root, file), line, ...literal })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return sites
}

export function checkSqlLiteralSchema(): {
  prepared: Record<Concern['name'], number>
  skipped: Record<Concern['name'], number>
} {
  const concerns: Concern[] = [
    {
      name: 'orchestrator',
      root: resolve(root, 'orchestrator/src'),
      migrate: applyOrchestratorMigrations,
    },
    {
      name: 'hub',
      root: resolve(root, 'hub/src'),
      migrate: (database) =>
        applyHubMigrations(database, undefined, {
          machine_id: '01990000-0000-7000-8000-000000000001',
        }),
    },
  ]
  const prepared = { orchestrator: 0, hub: 0 }
  const skipped = { orchestrator: 0, hub: 0 }
  const failures: string[] = []
  for (const concern of concerns) {
    const database = new Database(':memory:')
    try {
      concern.migrate(database)
      for (const site of sqlSites(concern)) {
        const key = `${site.file}:${site.line}`
        if (SQL_PREPARE_SKIPS[key]) {
          skipped[concern.name] += 1
          continue
        }
        try {
          database.prepare(site.sql)
          prepared[concern.name] += 1
        } catch (error) {
          failures.push(
            `${key}${site.interpolated ? ' (interpolated as NULL)' : ''}: ${(error as Error).message}`,
          )
        }
      }
    } finally {
      database.close()
    }
  }
  if (failures.length)
    throw new Error(
      `SQL literals do not prepare against the current schema:\n${failures.join('\n')}`,
    )
  return { prepared, skipped }
}

if (import.meta.main) {
  const result = checkSqlLiteralSchema()
  console.log(
    `SQL literal schema: prepared ${result.prepared.orchestrator} orchestrator and ${result.prepared.hub} hub statements; skipped ${result.skipped.orchestrator} orchestrator and ${result.skipped.hub} hub sites`,
  )
}
