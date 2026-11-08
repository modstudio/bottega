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
