#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'

const LARGE_TABLE_ROW_THRESHOLD = 10_000
const SLOW_AUDIT_STATEMENT_MS = 25

type Binding = string | number | bigint | boolean | null | Uint8Array
type Captured = { label: string; sql: string; bindings: Binding[] }
type AuditRow = {
  label: string
  sql: string
  bindings: Binding[]
  plan: string[]
  largeTableScan: boolean
  elapsedMs: number
  pagesRead: number | null
}

function usage(): never {
  throw new Error(
    'usage: bun scripts/audit-hot-store-statements.ts <store-path> [--json] [--allow-live-store]',
  )
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return resolve(left) === resolve(right)
  }
}

function flattenedBindings(args: unknown[]): Binding[] {
  const values = args.length === 1 && Array.isArray(args[0]) ? args[0] : args
  return values as Binding[]
}

function sqlLiteral(value: Binding): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`
  return `'${value.replaceAll("'", "''")}'`
}

function bindSql(sql: string, bindings: Binding[]): string {
  let index = 0
  let quoted = false
  let result = ''
  for (let offset = 0; offset < sql.length; offset++) {
    const character = sql[offset]!
    if (character === "'") {
      result += character
      if (quoted && sql[offset + 1] === "'") result += sql[++offset]!
      else quoted = !quoted
    } else if (character === '?' && !quoted) {
      result += sqlLiteral(bindings[index++] ?? null)
    } else result += character
  }
  return result
}

function sqliteStats(
  store: string,
  sql: string,
  work: string,
): { pages: number | null; ms: number } {
  const target = join(work, `statement-${crypto.randomUUID()}.db`)
  copyFileSync(store, target)
  const child = Bun.spawnSync(['sqlite3', target], {
    stdin: Buffer.from(`.stats on\n.timer on\n${sql.replace(/;?\s*$/, ';')}\n`),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = `${child.stdout.toString()}\n${child.stderr.toString()}`
  const misses = output.match(/Page cache misses:\s+(\d+)/i)
  const timer = output.match(/Run Time:\s+real\s+([0-9.]+)/i)
  if (child.exitCode !== 0 && !misses)
    throw new Error(`sqlite3 failed for ${sql}: ${output.trim()}`)
  return { pages: misses ? Number(misses[1]) : null, ms: timer ? Number(timer[1]) * 1_000 : 0 }
}

/** Make one transactionally consistent snapshot, including committed WAL pages. */
function snapshotStore(sourcePath: string, targetPath: string): void {
  const source = new Database(sourcePath, { readonly: true })
  try {
    source.query('VACUUM INTO ?').run(targetPath)
  } finally {
    source.close()
  }
}

function tableRows(database: Database, table: string): number {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return 0
  const exists = database
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table)
  if (!exists) return 0
  return (database.query(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number })
    .count
}

function scanTable(sql: string, token: string): string {
  for (const match of sql.matchAll(
    /\b(?:FROM|JOIN)\s+([A-Za-z_]\w*)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi,
  )) {
    if (match[1]?.toLowerCase() === token.toLowerCase()) return match[1]
    if (match[2]?.toLowerCase() === token.toLowerCase()) return match[1]!
  }
  return token
}

async function captureEntryPoints(
  store: string,
  work: string,
): Promise<{ captured: Captured[]; measuredStore: string }> {
  const routeStore = join(work, 'route.db')
  snapshotStore(store, routeStore)
  process.env.BOTTEGA_ORCHESTRATOR_DB = routeStore
  process.env.BOTTEGA_ORCHESTRATOR_DB_WRITE = '1'
  const captured: Captured[] = []
  let currentLabel = 'open-hooks'

  const [
    { db, migrateDatabase },
    { interposeStatementExecutions },
    { STANDARD_OPEN_HOOKS },
    promptBuckets,
    route,
    jobs,
    runtime,
  ] = await Promise.all([
    import('../orchestrator/src/database/db.ts'),
    import('../orchestrator/src/database/slow-statements.ts'),
    import('../orchestrator/src/runtime/store-hooks.ts'),
    import('../orchestrator/src/route/prompt-size-bucket-store.ts'),
    import('../orchestrator/src/route/route.ts'),
    import('../orchestrator/src/jobs/jobs.ts'),
    import('../orchestrator/src/runtime/runtime-registration.ts'),
  ])
  runtime.registerStandardRuntime()
  // The source store may trail this checkout's journal. Migrate only the disposable copy before
  // opening it through the adapter so capture uses the schema and indexes this binary audits.
  migrateDatabase()
  const processDatabase = db()
  interposeStatementExecutions(processDatabase, (sql, args) => {
    captured.push({ label: currentLabel, sql, bindings: flattenedBindings(args) })
  })

  // The real writable-open happened before db() exposed its handle. Replay the exact registered
  // hooks against a disposable copy so the source store remains read-only.
  for (const hook of STANDARD_OPEN_HOOKS.afterWritableOpen ?? []) hook(processDatabase)
  for (const hook of STANDARD_OPEN_HOOKS.afterInitialize ?? []) hook(processDatabase)

  for (const jobName of Object.keys(jobs.JOBS)) {
    currentLabel = `prompt-buckets:${jobName}`
    promptBuckets.promptBucketsForJob(jobName)
    currentLabel = `candidates:${jobName}`
    route.candidates(jobName)
  }
  currentLabel = 'pick:review-lens:safety'
  try {
    route.pick('review-lens', undefined, 0, false, null, {}, false, 'safety')
  } catch {
    // An empty fixture may have no eligible agent; the evidence reads have already executed.
  }
  currentLabel = 'priced:review-lens:safety'
  route.candidates('review-lens', 0, { lens: 'safety', priceCost: true })
  currentLabel = 'failover-successor:review-lens:safety'
  try {
    route.pick('review-lens', undefined, 0, false, null, { agents: ['codex'] }, false, 'safety')
  } catch {
    // Exhausted fixture routing still captures successor-selection reads.
  }
  processDatabase.close()
  return { captured, measuredStore: routeStore }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const storeArg = args.find((arg) => !arg.startsWith('--')) ?? usage()
  const store = resolve(storeArg)
  if (!existsSync(store)) throw new Error(`store does not exist: ${store}`)
  if (!Bun.which('sqlite3')) throw new Error('sqlite3 CLI is required on PATH')
  const liveStore = process.env.BOTTEGA_ORCHESTRATOR_DB
  if (liveStore && sameFile(store, liveStore) && !args.includes('--allow-live-store')) {
    throw new Error(`refusing live operator store ${store}; pass --allow-live-store explicitly`)
  }

  const work = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-planner-audit-`))
  try {
    const { captured, measuredStore } = await captureEntryPoints(store, work)
    const withoutRoutingIndexes = args.includes('--without-routing-indexes')
    if (withoutRoutingIndexes) {
      const baseline = new Database(measuredStore)
      baseline.exec(`
        DROP INDEX run_routing_evidence_cover;
        DROP INDEX run_routing_latency_cover;
        DROP INDEX run_routing_prompt_bucket_cover;
      `)
      baseline.close()
    }
    const distinct = new Map<string, Captured>()
    for (const row of captured) {
      const key = `${row.sql}\0${JSON.stringify(row.bindings)}`
      if (!distinct.has(key)) distinct.set(key, row)
    }
    const planner = new Database(measuredStore, { readonly: true })
    const rowCounts = new Map<string, number>()
    const rows: AuditRow[] = []
    for (const item of distinct.values()) {
      const capturedSql = bindSql(item.sql, item.bindings)
      const bound = withoutRoutingIndexes
        ? capturedSql.replace(
            /\s+INDEXED BY run_routing_(?:evidence|latency|prompt_bucket)_cover/g,
            '',
          )
        : capturedSql
      let plan: string[] = []
      try {
        plan = (
          planner.query(`EXPLAIN QUERY PLAN ${bound}`).all() as Array<{ detail: string }>
        ).map((row) => row.detail)
      } catch {
        plan = ['EXPLAIN unavailable']
      }
      const scanned = plan.flatMap((detail) => [...detail.matchAll(/\bSCAN\s+([A-Za-z_][\w]*)/gi)])
      const largeTableScan = scanned.some((match) => {
        const table = scanTable(item.sql, match[1]!)
        const count = rowCounts.get(table) ?? tableRows(planner, table)
        rowCounts.set(table, count)
        return count >= LARGE_TABLE_ROW_THRESHOLD
      })
      const stats = sqliteStats(measuredStore, bound, work)
      rows.push({ ...item, plan, largeTableScan, elapsedMs: stats.ms, pagesRead: stats.pages })
    }
    planner.close()

    printReport(rows, withoutRoutingIndexes, args.includes('--json'))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function printReport(rows: AuditRow[], withoutRoutingIndexes: boolean, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          mode: withoutRoutingIndexes ? 'without-routing-indexes' : 'current',
          thresholds: {
            largeTableRows: LARGE_TABLE_ROW_THRESHOLD,
            slowStatementMs: SLOW_AUDIT_STATEMENT_MS,
          },
          rows,
        },
        null,
        2,
      ),
    )
    return
  }
  console.log(
    `thresholds: large table >= ${LARGE_TABLE_ROW_THRESHOLD} rows; slow >= ${SLOW_AUDIT_STATEMENT_MS} ms`,
  )
  console.table(
    rows.map((row, index) => ({
      id: index + 1,
      entry: row.label,
      scan: row.largeTableScan ? 'LARGE' : '',
      ms: row.elapsedMs.toFixed(1),
      pages: row.pagesRead ?? 'unknown',
      plan: row.plan.join(' | '),
      sql: row.sql.replace(/\s+/g, ' ').trim().slice(0, 90),
    })),
  )
}

if (import.meta.main) await main()
