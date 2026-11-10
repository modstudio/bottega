// concern: record-no-destination-write-decision
/** Purely decides whether a hosted request is a write that fell back to the active space. */

import {
  type NoDestinationWrite,
  noDestinationWriteCause,
} from '../../../shared/record-no-destination-write-contract.ts'
import { recordRequestNature } from '../../../shared/record-space-request.ts'

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
    cause: noDestinationWriteCause(input.userAgent),
  }
}
