// concern: postgres-jsonb-binding
/** Binds one structured value for a PostgreSQL jsonb column through Bun SQL. */
import type { SQL } from 'bun'

export function bindJsonb(sql: SQL, value: unknown) {
  return sql`${value}::jsonb`
}
