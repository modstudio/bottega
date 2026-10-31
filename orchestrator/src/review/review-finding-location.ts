// concern: review-finding-location

type FindingLocationResolution = 'resolves' | 'absent' | 'unknown'

export type FindingLocationFact = {
  finding: number
  path: string
  resolution: FindingLocationResolution
}

/** Extract the repository path at the start of a review finding's location. */
export function reviewFindingRepositoryPath(location: string): string | null {
  const token =
    location
      .trim()
      .split(/\s/, 1)[0]
      ?.replace(/^`([^`]+)`$/, '$1') ?? ''
  const path = token
    .replace(/^\.\//, '')
    .replace(/[,;.]+$/, '')
    .replace(/(?:#L\d+(?:-L\d+)?|:\d+(?:[,:-]\d+)*)$/, '')
    .replace(/[,;.]+$/, '')
  if (!path || path === 'n/a' || path.startsWith('/')) return null
  const lastSegment = path.slice(path.lastIndexOf('/') + 1)
  return path.includes('/') || /\.[^.]+$/.test(lastSegment) ? path : null
}

/** Explain only locations known to be absent; unavailable checks remain silent. */
export function findingLocationNote(facts: readonly FindingLocationFact[]): string | null {
  const lines = facts.flatMap(({ finding, path, resolution }) =>
    resolution === 'absent'
      ? [`finding ${finding} location ${path} does not resolve on the reviewed tree`]
      : [],
  )
  return lines.length ? lines.join('\n') : null
}
