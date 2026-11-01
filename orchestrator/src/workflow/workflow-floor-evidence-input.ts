// concern: workflows
/** Validates scalar identifiers offered as floor evidence. */

export function positiveEvidenceId(value: number | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`)
  return value
}
