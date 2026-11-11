// concern: record-trial-space-contract
/** Stable transport and refusal shape shared by both destructive space-delete verbs. */
import type { RecordRemovalReport } from './record-removal-report.ts'

export class SpaceDeleteError extends Error {
  readonly status = 422
}
export type SpaceDeleteResult = {
  nothingToRemove: boolean
  activeSpaceCleared: boolean
  tables: RecordRemovalReport
  neutralized: Array<{ userId: string; email: string; sessions: number; machineKeys: number }>
}

function spaceDeleteResponse(body: unknown): SpaceDeleteResult {
  if (typeof body !== 'object' || body === null) throw new Error('invalid space deletion')
  const value = body as Record<string, unknown>
  if (
    typeof value.nothingToRemove !== 'boolean' ||
    typeof value.activeSpaceCleared !== 'boolean' ||
    !Array.isArray(value.tables) ||
    !value.tables.every(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        typeof (row as Record<string, unknown>).table === 'string' &&
        typeof (row as Record<string, unknown>).count === 'number',
    ) ||
    !Array.isArray(value.neutralized)
  )
    throw new Error('invalid space deletion')
  return value as SpaceDeleteResult
}

export const trialSpaceDeleteTransport = {
  options: (slug: string) => ({
    method: 'POST',
    body: JSON.stringify({ slug }),
    schema: spaceDeleteResponse,
  }),
  response: spaceDeleteResponse,
}

export const spaceDeleteTransport = {
  options: (slug: string, confirmation: string) => ({
    method: 'POST',
    body: JSON.stringify({ slug, confirmation }),
    schema: spaceDeleteResponse,
  }),
  response: spaceDeleteResponse,
}
