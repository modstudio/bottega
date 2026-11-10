// concern: record-no-destination-write-decision
/** Purely decides whether a hosted request is a write that fell back to the active space. */

import { recordRequestNature } from '../../../shared/record-space-request.ts'

export const MAX_CAUSE_LENGTH = 200

export type NoDestinationWrite = { spaceId: string; route: string; cause: string }

export function destinationlessWrite(input: {
  method: string
  destinationSpaceId?: string
  activeSpaceId: string | null
  route: string
  userAgent?: string | null
}): NoDestinationWrite | null {
  if (recordRequestNature(input.method) === 'read') return null
  if (input.destinationSpaceId !== undefined || !input.activeSpaceId) return null
  return {
    spaceId: input.activeSpaceId,
    route: input.route,
    cause: (input.userAgent?.trim() || 'unknown').slice(0, MAX_CAUSE_LENGTH),
  }
}
