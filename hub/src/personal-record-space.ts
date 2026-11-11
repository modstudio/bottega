import {
  RECORD_PERSONAL_SPACE_REMEDY,
  RECORD_SIGN_IN_REMEDY,
} from '../../shared/record-remedies.ts'
import { readRecordSessionTokenAsync } from '../../shared/record-session.ts'
import { createRecordClient, requiredRecordApiUrl } from './record-client.ts'
import type { RecordFetch } from './record-client-options.ts'

export type PersonalRecordSpaceOptions = {
  token?: string | null
  fetch?: RecordFetch
  requestDeadlineMs?: number
}

/** Resolve the signed-in record user's personal space from the record API identity. */
export async function personalRecordSpace(
  options: PersonalRecordSpaceOptions = {},
): Promise<string> {
  const token = options.token === undefined ? await readRecordSessionTokenAsync() : options.token
  if (!token) throw new Error(RECORD_SIGN_IN_REMEDY)
  const identity = await createRecordClient({
    baseUrl: requiredRecordApiUrl(),
    headers: { authorization: `Bearer ${token}` },
    fetch: options.fetch,
    requestDeadlineMs: options.requestDeadlineMs,
  }).whoami()
  if (!identity.personalSpaceId)
    throw new Error(`record user has no personal space; ${RECORD_PERSONAL_SPACE_REMEDY}`)
  return identity.personalSpaceId
}
