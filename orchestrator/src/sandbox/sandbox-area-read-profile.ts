// concern: adapts area and protected read policy to sandbox-runtime filesystem fields.

import { isAbsolute, relative } from 'node:path'

export const isAtOrBelow = (path: string, parent: string) => {
  const fromParent = relative(parent, path)
  return fromParent === '' || (!fromParent.startsWith('..') && !isAbsolute(fromParent))
}

/** Assemble broad area policy and protected denies in sandbox-runtime field names. */
export function assembleAreaReadProfile(input: {
  areaDeny: readonly string[]
  candidateAllows: readonly string[]
  protectedDenies: readonly string[]
  socketDenyPaths: readonly string[]
}): { denyRead: string[]; allowWithinDeny: string[] } {
  return {
    denyRead: [...new Set([...input.areaDeny, ...input.protectedDenies, ...input.socketDenyPaths])],
    allowWithinDeny: [...new Set(input.candidateAllows)].filter(
      (allowed) =>
        !input.protectedDenies.some(
          (denied) => isAtOrBelow(allowed, denied) || isAtOrBelow(denied, allowed),
        ),
    ),
  }
}
