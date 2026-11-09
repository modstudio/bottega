// concern: hosted-table-guard
/** Refuses local SQL access to hosted-only tables while preserving an explicit maintenance bypass. */
import type { Database } from 'bun:sqlite'
import { HOSTED_TABLES_WITHOUT_LOCAL_ACCESS } from '../../../shared/hosted-tables.ts'

const guardedMethods = new Set(['query', 'prepare', 'run', 'exec'])

export function guardHostedTables(
  database: Database,
  tables: readonly string[] = HOSTED_TABLES_WITHOUT_LOCAL_ACCESS,
): Database {
  if (tables.length === 0) return database
  const checks = new Map<string, string | null>()
  const namedTable = (sql: string): string | null => {
    const cached = checks.get(sql)
    if (cached !== undefined || checks.has(sql)) return cached ?? null
    const found =
      tables.find((table) =>
        new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(table)}([^A-Za-z0-9_]|$)`, 'i').test(sql),
      ) ?? null
    checks.set(sql, found)
    return found
  }
  return new Proxy(database, {
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
}

/** Migrations and later verify-then-delete maintenance intentionally use the unwrapped handle. */
export const hostedTableGuardBypass = (database: Database): Database => database

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
