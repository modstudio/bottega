// concern: workflows
/** Validates workflow command argument values independently of command behavior. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'

export const positive = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`)
  return n
}

export const obligationUuid = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  if (!hasRecordIdShape(value))
    throw new Error(
      `--satisfies must be an obligation UUID from ${PLATFORM_SLUG} workflow cursors --json`,
    )
  return value.toLowerCase()
}
