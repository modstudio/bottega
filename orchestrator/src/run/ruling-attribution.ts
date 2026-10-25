// concern: ruling-attribution
/** Owns which person's name, if any, is recorded for a ruling. */

import { userInfo } from 'node:os'
import { db } from '../database/db.ts'
import { cachedSignedInRecordUser } from '../record/record-session.ts'

export function rulingPersonName(
  fromOperator: boolean,
  cachedName: string | null,
  machineUsername: string,
): string | null {
  if (!fromOperator) return null
  return cachedName ?? machineUsername
}

export function resolvedRulingPersonName(fromOperator: boolean): string | null {
  if (!fromOperator) return null
  try {
    return rulingPersonName(true, cachedSignedInRecordUser(db())?.name ?? null, userInfo().username)
  } catch {
    return rulingPersonName(true, null, userInfo().username)
  }
}
