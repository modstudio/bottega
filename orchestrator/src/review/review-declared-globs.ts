// concern: review-declared-globs
/** Knows whether any path matches any declared glob. Must import nothing. */

/** True when at least one path matches at least one pattern. */
export function declaredGlobsMatch(paths: readonly string[], patterns: readonly string[]): boolean {
  return patterns.some((pattern) => paths.some((path) => new Bun.Glob(pattern).match(path)))
}
