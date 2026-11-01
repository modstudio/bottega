// concern: lens-profile-version
/** Return the next unused profile version number across its current and revision rows. */
export function nextLensProfileVersion(
  current: number,
  revisionNumbers: readonly number[],
): number {
  return Math.max(current, ...revisionNumbers) + 1
}
