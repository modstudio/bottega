// concern: record-value-conversions
/** Converts nullable scalar payload values for hosted-record writes. */
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { OutboxRowError } from './outbox-failure.ts'

export const nullableBigint = (value: unknown) => (value == null ? null : BigInt(String(value)))

export const nullableNumber = (value: unknown) => (value == null ? null : Number(value))

export function nullableUuid(value: unknown, field: string): string | null {
  if (value == null) return null
  const id = String(value)
  if (!hasRecordIdShape(id)) {
    throw new OutboxRowError(`${field} must be a UUID or null`, 'row-validation')
  }
  return id
}
