// concern: record-bigint
/** Decodes the JSON representation of a Postgres bigint returned by the hosted record. */
import { getTableColumns } from 'drizzle-orm'
import type { AnyPgTable } from 'drizzle-orm/pg-core'
import { z } from 'zod'

export const recordBigintSchema = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?\d+$/)
    .transform(Number),
])

export const recordBigint = (value: string | number | bigint): number =>
  recordBigintSchema.parse(typeof value === 'bigint' ? String(value) : value)

export function bigintColumns(table: AnyPgTable): ReadonlySet<string> {
  return new Set(
    Object.values(getTableColumns(table))
      .filter((column) => column.getSQLType() === 'bigint')
      .map((column) => column.name),
  )
}

export function decodeRecordBigintColumns<T extends object>(
  row: T,
  columns: ReadonlySet<string>,
): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      columns.has(key) ? recordBigint(value as string | number | bigint) : value,
    ]),
  ) as T
}
