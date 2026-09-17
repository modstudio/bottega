// concern: review-coverage-match
/** Knows whether files_covered claims intersect a changed-path set. Must import nothing. */

const SURROUNDING = /^[,;:"'()[\]{}]+|[,;:"'()[\]{}]+$/g

/** True when at least one changed path is named by a files_covered claim. */
export function filesCoveredIntersectChanged(
  changed: readonly string[],
  covered: readonly string[],
): boolean {
  return coverageClaims(changed, covered).some(tokenCoversChangedPath)
}

function coverageClaims(
  changed: readonly string[],
  covered: readonly string[],
): { path: string; token: string }[] {
  const paths = changed.map(stripLeadingDotSlash)
  const tokens = covered.flatMap(coverageTokens)
  const claims: { path: string; token: string }[] = []
  for (const path of paths) {
    for (const token of tokens) claims.push({ path, token })
  }
  return claims
}

function coverageTokens(entry: string): string[] {
  const tokens = [normalizeCoverageToken(entry)]
  for (const piece of entry.split(/\s+/)) tokens.push(normalizeCoverageToken(piece))
  return tokens.filter(nonemptyToken)
}

function nonemptyToken(token: string): boolean {
  return token.length > 0
}

function normalizeCoverageToken(token: string): string {
  return stripLeadingDotSlash(token.replace(SURROUNDING, ''))
}

function stripLeadingDotSlash(path: string): string {
  return path.replace(/^\.\//, '')
}

function tokenCoversChangedPath({ path, token }: { path: string; token: string }): boolean {
  return token === path || path.endsWith(`/${token}`) || token.endsWith(`/${path}`)
}
