// concern: record-no-destination-write-decision
/** Purely decides whether a hosted request is a write that fell back to the active space. */

const MAX_CAUSE_LENGTH = 200

export type NoDestinationWrite = { spaceId: string; route: string; cause: string }

export function destinationlessWrite(input: {
  method: string
  destinationRequested?: boolean
  destinationSpaceId?: string
  activeSpaceId: string | null
  route: string
  userAgent?: string | null
}): NoDestinationWrite | null {
  if (input.method === 'GET' || input.method === 'HEAD') return null
  if (input.destinationRequested || input.destinationSpaceId !== undefined || !input.activeSpaceId)
    return null
  return {
    spaceId: input.activeSpaceId,
    route: input.route,
    cause: (input.userAgent?.trim() || 'unknown').slice(0, MAX_CAUSE_LENGTH),
  }
}
