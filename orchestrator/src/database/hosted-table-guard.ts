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

export const HOSTED_LOCAL_SQL_ALLOWED_FILES = [
  {
    pattern: /^orchestrator\/src\/question-store\/question-store-sqlite(?:-[^/]+)?\.ts$/,
    reason: 'SQLite question adapters are selected only by question-store.ts on local installs',
  },
  {
    pattern: /^orchestrator\/src\/workflow\/task-flow-store-sqlite(?:-[^/]+)?\.ts$/,
    reason: 'SQLite task-flow adapters are selected only by task-flow-store.ts on local installs',
  },
  {
    pattern: /^orchestrator\/migrations\//,
    reason: 'SQLite migrations operate on the unguarded migration-step handle',
  },
  {
    pattern:
      /^orchestrator\/src\/database\/(?:migrations(?:-[^/]+)?|[^/]+-migration-preflight)\.ts$/,
    reason: 'SQLite migration preflights operate on the unguarded migration-step handle',
  },
  {
    pattern: /^orchestrator\/src\/postgres\//,
    reason:
      'Postgres record modules operate on the hosted record rather than a guarded SQLite handle',
  },
  {
    pattern:
      /^orchestrator\/src\/record\/(?:record-question-(?:number|write)|record-task-flow(?:-write)?)\.ts$/,
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
  },
  {
    pattern: /^orchestrator\/src\/record\/record-cache-workflow\.ts$/,
    reason: 'The workflow record cache writes only the local cache during record synchronization',
  },
  {
    pattern: /^orchestrator\/src\/session-report\/session-report-adapter\.ts$/,
    reason:
      'The session report SQLite adapter is used only where the local report store is authoritative',
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
