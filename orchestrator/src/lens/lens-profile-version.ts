// concern: lens-profile-version
/** Return the next unused profile version number across its current and revision rows. */
export function nextLensProfileVersion(
  current: number,
  revisionNumbers: readonly number[],
): number {
  return Math.max(current, ...revisionNumbers) + 1
}

/** Serialize the body and enabled state retained by a profile revision. */
export function lensProfileSnapshot(body: string, enabled: boolean): string {
  return JSON.stringify({ body: JSON.parse(body), enabled })
}
