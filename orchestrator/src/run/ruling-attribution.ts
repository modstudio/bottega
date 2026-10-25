// concern: ruling-attribution
/** Owns which person's name, if any, is recorded for a ruling. */

import type { Database } from 'bun:sqlite'
import { userInfo } from 'node:os'
import { db } from '../database/db.ts'
import { cachedSignedInRecordUser } from '../record/record-session.ts'

export function rulingPersonName(
  fromOperator: boolean,
  input: { database?: Database; machineUsername?: () => string } = {},
): string | null {
  if (!fromOperator) return null
  const machineUsername = input.machineUsername ?? (() => userInfo().username)
  try {
    return cachedSignedInRecordUser(input.database ?? db())?.name ?? machineUsername()
  } catch {
    return machineUsername()
  }
}
