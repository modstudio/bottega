// concern: node-requirement
/** Owns the Node version requirement shared by architecture checks and machine diagnostics. */

export const MINIMUM_DEPENDENCY_CRUISER_NODE_MAJOR = 24

export function nodeVersionMajor(version: string): number | null {
  const match = /^v?(\d+)(?:\.|$)/.exec(version.trim())
  if (!match) return null
  const major = Number(match[1])
  return Number.isSafeInteger(major) ? major : null
}
