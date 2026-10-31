import type { Database } from 'bun:sqlite'

export type IngestTransaction = <T>(fn: (conn: Database) => T) => T

export function chunks<T>(rows: readonly T[], size: number): readonly T[][] {
  return Array.from({ length: Math.max(1, Math.ceil(rows.length / size)) }, (_, index) =>
    rows.slice(index * size, (index + 1) * size),
  )
}
