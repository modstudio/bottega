// concern: record-value-conversions
/** Converts nullable scalar payload values for hosted-record writes. */

export const nullableBigint = (value: unknown) => (value == null ? null : BigInt(String(value)))

export const nullableNumber = (value: unknown) => (value == null ? null : Number(value))
