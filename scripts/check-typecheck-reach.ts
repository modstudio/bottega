/** Return tracked TypeScript sources absent from every resolved typecheck file set. */
export function uncoveredTypeScriptPaths(
  trackedPaths: readonly string[],
  resolvedFileSets: readonly (readonly string[])[],
): string[] {
  const covered = new Set(resolvedFileSets.flat())
  return trackedPaths
    .filter((path) => /\.tsx?$/.test(path) && !covered.has(path))
    .sort((left, right) => left.localeCompare(right))
}
