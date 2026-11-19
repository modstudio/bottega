// concern: hosted-table-guard
/** Refuses local SQL access to hosted-only tables; maintenance uses the migration-step handle. */
import type { Database } from 'bun:sqlite'

/**
 * A table joins this list only when identity-state-classes declares it hosted and production code
 * no longer reads or writes its local copy.
 */
export const HOSTED_TABLES_WITHOUT_LOCAL_ACCESS = [
  'question',
  'question_mutation_audit',
  'task_flow',
  'workflow_cursor',
  'workflow_obligation',
  'workflow_step_text',
  'workflow_text_copy',
] as const

/** Production SQLite adapter modules whose handles are selected away on hosted installs. */
export const LOCAL_SQLITE_ADAPTER_PATH =
  '^orchestrator/src/(?:question-store/question-store-sqlite|workflow/task-flow-store-sqlite)[^/]*\\.ts$'

// Exact-path exemptions pin the number of hosted-table and unresolved sites they allow. Adapter
// families and directory prefixes are intentionally uncounted because local SQL is their purpose.
export const HOSTED_LOCAL_SQL_ALLOWED_FILES = [
  {
    pattern: new RegExp(LOCAL_SQLITE_ADAPTER_PATH),
    reason:
      'SQLite question and task-flow adapters are selected only by their store selectors on local installs',
  },
  {
    pattern:
      /^orchestrator\/src\/database\/(?:migrations(?:-[^/]+)?|[^/]+-migration-preflight)\.ts$/,
    reason: 'SQLite migration preflights operate on the unguarded migration-step handle',
  },
  {
    pattern:
      /^orchestrator\/src\/record\/(?:record-question-(?:number|read|write)|record-task-flow(?:-write)?)\.ts$/,
    reason:
      'Postgres record modules operate on the hosted record rather than a guarded SQLite handle',
  },
  {
    pattern: /^orchestrator\/(?:test\/|.*\.fixture\.ts$)/,
    reason: 'Fixtures own isolated stores and never receive the production guarded handle',
  },
  {
    pattern: /^orchestrator\/src\/database\/entity-number\.ts$/,
    reason: 'The local identity-number adapter is reached only for local stores',
    expectedSites: 1,
  },
  {
    pattern: /^orchestrator\/src\/database\/slow-statements\.ts$/,
    reason:
      'SQL timing instrumentation transparently forwards dynamic statements to the handle it wraps; the runtime hosted-table guard remains the backstop',
    expectedSites: 2,
  },
  {
    pattern: /^orchestrator\/src\/database\/db\.ts$/,
    reason:
      'Local connection write probes run before store-hooks wraps the handle and constrain dynamic table names to WRITE_PROBE_TABLE_PREFIX',
    expectedSites: 2,
  },
  {
    pattern: /^orchestrator\/src\/database\/hosted-row-release\.ts$/,
    reason: 'Verifies and releases local copies on the migration-step handle',
    expectedSites: 8,
  },
  {
    pattern: /^orchestrator\/src\/record\/(?:record-board-claims|record-projects|record-sync)\.ts$/,
    reason:
      'Postgres record modules operate on the hosted record rather than a guarded SQLite handle',
  },
  {
    pattern: /^orchestrator\/src\/record\/(?:outbox-prune|record-cache-lens)\.ts$/,
    reason:
      'Record synchronization adapters query only their machine-local outbox and cache tables',
  },
  {
    pattern: /^orchestrator\/src\/record\/record-history-upload\.ts$/,
    reason:
      'History upload local hosted-table SQL requires the owned maintenance handle before hosted release',
    expectedSites: 6,
  },
  {
    pattern: /^orchestrator\/src\/record\/record-hosted-row-presence\.ts$/,
    reason: 'Shared maintenance reader collects local hosted-history ids before presence checks',
    expectedSites: 7,
  },
  {
    pattern: /^orchestrator\/src\/record\/record-cache-workflow\.ts$/,
    reason:
      'Workflow record-cache SQL is selected only on local installs by readRecordInstallBinding(local).bound',
    expectedSites: 1,
  },
  {
    pattern: /^orchestrator\/src\/session-report\/session-report-adapter\.ts$/,
    reason:
      'Workflow-cursor report SQL is selected only on local installs by currentRecordWriteDecision(database).verdict',
    expectedSites: 1,
  },
  {
    pattern: /^orchestrator\/src\/doc\/doc-read-store\.ts$/,
    reason: 'The local document read adapter builds SQL only for machine-local document tables',
    expectedSites: 1,
  },
] as const

const guardedMethods = new Set(['query', 'prepare', 'run', 'exec'])
// A listed name ends where no identifier character follows, so a name closed by a parenthesis
// or semicolon is still a reference, while a longer name sharing its prefix is another table.
const NAME_END = '(?![A-Za-z0-9_$])'
const SQL_IDENTIFIER = '(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+"|`[^`]+`|\\[[^\\]]+\\])'

export function guardHostedTables(
  database: Database,
  tables: readonly string[] = HOSTED_TABLES_WITHOUT_LOCAL_ACCESS,
): Database {
  if (tables.length === 0) return database
  const checks = new Map<string, string | null>()
  const namedTable = (sql: string): string | null => {
    const cached = checks.get(sql)
    if (cached !== undefined || checks.has(sql)) return cached ?? null
    const found = hostedTableInSql(sql, tables)
    checks.set(sql, found)
    return found
  }
  const guarded = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (
        typeof property !== 'string' ||
        !guardedMethods.has(property) ||
        typeof value !== 'function'
      )
        return typeof value === 'function' ? value.bind(target) : value
      return (sql: string, ...args: unknown[]) => {
        const table = namedTable(sql)
        if (table)
          throw new Error(
            `${table} is held by the hosted record on this install; read or write it through the record API`,
          )
        return Reflect.apply(value, target, [sql, ...args])
      }
    },
  }) as Database
  return guarded
}

export function hostedTableInSql(sql: string, tables: readonly string[]): string | null {
  return (
    tables.find((table) => {
      const escaped = escapeRegExp(table)
      const tableName = `(?:${escaped}|"${escaped}"|\`${escaped}\`|\\[${escaped}\\])`
      const qualifier = `(?:${SQL_IDENTIFIER}\\s*\\.\\s*)?`
      const direct = `\\b(?:FROM|JOIN|INTO|UPDATE|TABLE|DELETE\\s+FROM)\\s+(?:\\(\\s*)?${qualifier}${tableName}${NAME_END}`
      const tableReference = `${qualifier}${SQL_IDENTIFIER}(?:\\s+(?:AS\\s+)?${SQL_IDENTIFIER})?`
      const commaList = `\\bFROM\\s+${tableReference}(?:\\s*,\\s*${tableReference})*\\s*,\\s*${qualifier}${tableName}${NAME_END}`
      return new RegExp(`(?:${direct}|${commaList})`, 'i').test(sql)
    }) ?? null
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
