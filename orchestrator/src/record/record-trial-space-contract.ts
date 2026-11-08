// concern: record-trial-space-contract
/** Stable transport and refusal shape for the destructive trial-space verb. */
export class TrialSpaceDeleteError extends Error {
  readonly status = 422
}
export type TrialSpaceDeleteResult = {
  nothingToRemove: boolean
  activeSpaceCleared: boolean
  tables: Record<string, number>
  neutralized: Array<{ userId: string; email: string; sessions: number; machineKeys: number }>
}

function trialSpaceDeleteResponse(body: unknown): TrialSpaceDeleteResult {
  if (typeof body !== 'object' || body === null) throw new Error('invalid trial-space deletion')
  const value = body as Record<string, unknown>
  if (
    typeof value.nothingToRemove !== 'boolean' ||
    typeof value.activeSpaceCleared !== 'boolean' ||
    typeof value.tables !== 'object' ||
    value.tables === null ||
    !Array.isArray(value.neutralized)
  )
    throw new Error('invalid trial-space deletion')
  return value as TrialSpaceDeleteResult
}

export const trialSpaceDeleteTransport = {
  options: (slug: string) => ({
    method: 'POST',
    body: JSON.stringify({ slug }),
    schema: trialSpaceDeleteResponse,
  }),
  response: trialSpaceDeleteResponse,
}
