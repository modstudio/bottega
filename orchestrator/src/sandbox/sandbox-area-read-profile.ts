// concern: adapts area and protected read policy to sandbox-runtime filesystem fields.

import { carveBackOutsideProtected } from './area-read-policy.ts'

/** Assemble broad area policy and protected denies in sandbox-runtime field names. */
export function assembleAreaReadProfile(input: {
  areaDeny: readonly string[]
  candidateAllows: readonly string[]
  protectedDenies: readonly string[]
  socketDenyPaths: readonly string[]
}): { denyRead: string[]; allowWithinDeny: string[] } {
  return {
    denyRead: [...new Set([...input.areaDeny, ...input.protectedDenies, ...input.socketDenyPaths])],
    allowWithinDeny: [...new Set(input.candidateAllows)].filter((allowed) =>
      carveBackOutsideProtected(allowed, input.protectedDenies),
    ),
  }
}
