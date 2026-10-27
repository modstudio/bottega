/** Decides the source-file list for a document command write. */

export type DocSourceFileUpdate = {
  given: readonly string[]
  replace: boolean
}

export function mergeDocSourceFiles(
  existing: readonly string[],
  given: readonly string[],
  replace: boolean,
): string[] {
  return [...new Set(replace ? given : [...existing, ...given])]
}
