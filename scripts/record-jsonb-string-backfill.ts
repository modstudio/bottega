#!/usr/bin/env bun
import { SQL } from 'bun'
import { PLATFORM_NAME } from '../shared/brand.ts'

const BATCH_SIZE = 500
const BATCH_PAUSE_MS = 200
export const MAX_CONSECUTIVE_TIMEOUTS = 5

export type BackfillColumn = {
  table: string
  column: string
  primaryKey: string
  narrowingPredicate?: string
}

const id = (table: string, column: string): BackfillColumn => ({
  table,
  column,
  primaryKey: 'id',
})

export const BACKFILL_COLUMNS: readonly BackfillColumn[] = [
  id('run', 'changed_paths'),
  id('run', 'doc_revisions'),
  id('run', 'outside_worktree_writes'),
  id('run', 'review_provenance'),
  id('run', 'provisioning_phases'),
  id('run', 'provisioning_host_load'),
  id('run', 'provisioning_entry_roots'),
  id('run', 'withheld_fields'),
  { table: 'run_score', column: 'withheld_fields', primaryKey: 'run_id' },
  id('review', 'tier_reasons'),
  id('review', 'path_set'),
  id('review', 'withheld_fields'),
  id('review_lens', 'standards_read'),
  id('review_lens', 'files_covered'),
  id('review_lens', 'commands_run'),
  id('review_lens', 'could_not_verify'),
  id('review_lens', 'mcp_tools'),
  id('review_lens', 'docs_read'),
  id('review_lens', 'substitutes'),
  id('review_lens', 'withheld_fields'),
  id('review_finding', 'withheld_fields'),
  id('review_read', 'path_set'),
  id('review_read', 'withheld_fields'),
  id('landing', 'path_set'),
  id('landing', 'steps'),
  id('landing', 'withheld_fields'),
  id('landing_override', 'path_set'),
  {
    table: 'landing_override',
    column: 'missing_lenses',
    primaryKey: 'id',
    narrowingPredicate: `CASE WHEN pg_input_is_valid("missing_lenses" #>> '{}', 'jsonb') THEN jsonb_typeof(("missing_lenses" #>> '{}')::jsonb) = 'array' ELSE false END`,
  },
  id('landing_override', 'withheld_fields'),
  id('pull_request_ci', 'failed_jobs'),
  id('pull_request_ci', 'withheld_fields'),
  id('contention', 'withheld_fields'),
  id('test_flake', 'load_at_failure'),
  id('test_flake', 'withheld_fields'),
  id('branch_disposal', 'withheld_fields'),
  id('question', 'options'),
  id('question', 'withheld_fields'),
  id('release', 'withheld_fields'),
]

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function buildSelectionPredicate(target: BackfillColumn): string {
  const column = quoteIdentifier(target.column)
  const base =
    `jsonb_typeof(${column}) = 'string' AND ` + `pg_input_is_valid(${column} #>> '{}', 'jsonb')`
  return target.narrowingPredicate ? `${base} AND ${target.narrowingPredicate}` : base
}

export function buildColumnSql(target: BackfillColumn): { count: string; update: string } {
  const table = quoteIdentifier(target.table)
  const column = quoteIdentifier(target.column)
  const primaryKey = quoteIdentifier(target.primaryKey)
  const predicate = buildSelectionPredicate(target)
  return {
    count: `SELECT count(*)::bigint AS count FROM ${table} WHERE ${predicate}`,
    update: `UPDATE ${table} SET ${column} = (${column} #>> '{}')::jsonb
WHERE ${primaryKey} IN (
  SELECT ${primaryKey} FROM ${table}
  WHERE ${predicate}
  LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
)
RETURNING ${primaryKey}`,
  }
}

export type RetryDecision = 'retry' | 'stop' | 'rethrow'

export function retryDecision(sqlState: string | null, consecutiveTimeouts: number): RetryDecision {
  if (sqlState !== '55P03' && sqlState !== '57014') return 'rethrow'
  return consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS ? 'stop' : 'retry'
}

type Arguments = { databaseUrl: string; userId: string; dryRun: boolean }
type CountRow = { count: string | number | bigint }

function parseArguments(argv: string[]): Arguments {
  const databaseUrl = argv[0]
  if (!databaseUrl || databaseUrl.startsWith('--')) {
    throw new Error(
      `database URL must be the first argument; run through \`${PLATFORM_NAME.toLowerCase()} machine config secret run\``,
    )
  }
  let userId: string | undefined
  let dryRun = false
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') {
      dryRun = true
      continue
    }
    if (argument === '--user' && argv[index + 1]) {
      userId = argv[index + 1]
      index += 1
      continue
    }
    throw new Error(`unknown or incomplete argument ${argument}; use --user <uuid> [--dry-run]`)
  }
  if (!userId) throw new Error('missing required --user <uuid> argument')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error('--user must be a UUID')
  }
  return { databaseUrl, userId, dryRun }
}

function backfillTables(): string[] {
  return [...new Set(BACKFILL_COLUMNS.map((target) => target.table))]
}

function sqlState(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { code?: unknown; errno?: unknown }
  for (const value of [candidate.errno, candidate.code]) {
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const normalized = String(value).toUpperCase()
    if (/^[0-9A-Z]{5}$/.test(normalized)) return normalized
  }
  return null
}

function countValue(rows: CountRow[]): bigint {
  return BigInt(String(rows[0]?.count ?? 0))
}

async function spacesForUser(client: SQL, userId: string): Promise<string[]> {
  await client`SELECT set_config('app.user_id', ${userId}, false)`
  await client`SELECT set_config('app.space_id', '', false)`
  const rows = await client`
    SELECT space_id::text AS space_id
    FROM membership
    WHERE user_id=${userId}::uuid
    ORDER BY space_id
  `
  return rows.map((row: Record<string, unknown>) => String(row.space_id))
}

function printSpaces(stage: 'before' | 'after', spaces: readonly string[]): void {
  console.log(`${stage} spaces (${spaces.length}): ${spaces.join(', ')}`)
}

async function countVisibleRows(client: SQL, table: string, spaces: readonly string[]) {
  let visible = 0n
  for (const space of spaces) {
    visible += await client.begin(async (tx) => {
      await tx`SELECT set_config('app.space_id', ${space}, true)`
      return countValue(
        await tx.unsafe<CountRow[]>(
          `SELECT count(*)::bigint AS count FROM ${quoteIdentifier(table)}`,
        ),
      )
    })
  }
  return visible
}

async function estimatedRows(client: SQL, table: string): Promise<bigint> {
  const rows = await client<CountRow[]>`
    SELECT n_live_tup::bigint AS count
    FROM pg_stat_user_tables
    WHERE schemaname=current_schema() AND relname=${table}
  `
  if (!rows[0]) throw new Error(`pg_stat_user_tables has no row for ${table}`)
  return countValue(rows)
}

async function printReachabilityReport(
  client: SQL,
  stage: 'before' | 'after',
  spaces: readonly string[],
): Promise<void> {
  console.log(`${stage} reachability:`)
  for (const table of backfillTables()) {
    const visible = await countVisibleRows(client, table, spaces)
    const estimated = await estimatedRows(client, table)
    const difference = estimated - visible
    const reachability =
      difference > 0n ? `unreached (estimate)=${difference}` : `difference=${difference}`
    console.log(`  ${table}: visible=${visible} n_live_tup=${estimated} ${reachability}`)
  }
}

async function countTarget(client: SQL, space: string, target: BackfillColumn): Promise<bigint> {
  const { count } = buildColumnSql(target)
  return client.begin(async (tx) => {
    await tx`SELECT set_config('app.space_id', ${space}, true)`
    return countValue(await tx.unsafe<CountRow[]>(count))
  })
}

async function updateBatch(client: SQL, space: string, target: BackfillColumn): Promise<number> {
  const { update } = buildColumnSql(target)
  return client.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '2s'")
    await tx.unsafe("SET LOCAL statement_timeout = '15s'")
    await tx`SELECT set_config('app.space_id', ${space}, true)`
    return (await tx.unsafe<Record<string, unknown>[]>(update)).length
  })
}

const pause = () => Bun.sleep(BATCH_PAUSE_MS)

async function backfillTarget(client: SQL, space: string, target: BackfillColumn): Promise<number> {
  let batches = 0
  let consecutiveTimeouts = 0
  for (;;) {
    try {
      const updated = await updateBatch(client, space, target)
      consecutiveTimeouts = 0
      if (updated === 0) return batches
      batches += 1
      await pause()
    } catch (error) {
      consecutiveTimeouts += 1
      const decision = retryDecision(sqlState(error), consecutiveTimeouts)
      if (decision === 'rethrow') throw error
      if (decision === 'stop') {
        throw new Error(
          `stopped after ${MAX_CONSECUTIVE_TIMEOUTS} consecutive timeouts at ` +
            `${target.table}.${target.column} in space ${space}; clear contention and rerun to resume`,
        )
      }
      await pause()
    }
  }
}

async function dryRun(client: SQL, spaces: readonly string[]): Promise<void> {
  for (const space of spaces) {
    for (const target of BACKFILL_COLUMNS) {
      const count = await countTarget(client, space, target)
      console.log(`${space} ${target.table}.${target.column}: ${count}`)
    }
  }
}

async function runBackfill(client: SQL, spaces: readonly string[]): Promise<void> {
  for (const space of spaces) {
    for (const target of BACKFILL_COLUMNS) {
      const startedAt = performance.now()
      const before = await countTarget(client, space, target)
      const batches = await backfillTarget(client, space, target)
      const after = await countTarget(client, space, target)
      const wallTimeMs = Math.round(performance.now() - startedAt)
      console.log(
        `${space} ${target.table}.${target.column}: before=${before} after=${after} ` +
          `batches=${batches} wall_ms=${wallTimeMs}`,
      )
    }
  }
}

async function main(argv: string[]): Promise<void> {
  const input = parseArguments(argv)
  const client = new SQL(input.databaseUrl, { max: 1 })
  try {
    const beforeSpaces = await spacesForUser(client, input.userId)
    if (beforeSpaces.length === 0) {
      throw new Error(`zero spaces are visible to --user; grant that user membership and rerun`)
    }
    printSpaces('before', beforeSpaces)
    await printReachabilityReport(client, 'before', beforeSpaces)
    if (input.dryRun) await dryRun(client, beforeSpaces)
    else await runBackfill(client, beforeSpaces)
    const afterSpaces = await spacesForUser(client, input.userId)
    printSpaces('after', afterSpaces)
    await printReachabilityReport(client, 'after', afterSpaces)
  } finally {
    await client.close()
  }
}

if (import.meta.main) {
  let databaseUrl = ''
  try {
    databaseUrl = Bun.argv[2] ?? ''
    await main(Bun.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(
      databaseUrl ? message.replaceAll(databaseUrl, '[database URL withheld]') : message,
    )
    process.exitCode = 1
  }
}
