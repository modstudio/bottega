// concern: branch-name
/** Knows only the branch-name shapes that cannot be recorded as branch identity. */

/** Whether a branch value is indistinguishable from a short or full commit id. */
export function isCommitShapedBranch(value: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(value)
}
