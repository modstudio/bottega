// concern: review-same-change
/** Decides whether two observed ranges represent the same reviewable change. */

export type ChangeFacts = {
  patchId: string | null
  zeroContextPatchId: string | null
  paths: readonly string[] | null
  message: string | null
}

export type StoredChangeRow = {
  patchId: string | null
  zeroContextPatchId: string | null
  pathSet: string | null
}

type ReplayResult =
  | { kind: 'same-tree' }
  | { kind: 'different-tree' | 'conflict' }
  | { kind: 'unavailable'; reason: string }
  | null

export type SameChangeFacts = {
  reviewed: ChangeFacts
  current: ChangeFacts
  replay: ReplayResult
}

export type SameChangeDecision = {
  same: boolean
  basis: 'zero-context' | 'legacy' | 'replay' | 'different'
  messageChanged: boolean
  reason: string | null
}

const samePaths = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())

/** Hash a single diff section by its content and metadata, independent of path and hunk offsets. */
export function pathNeutralContentIdentity(section: string): string {
  let header = true
  const normalized = section
    .split('\n')
    .flatMap((line) => {
      if (line.startsWith('@@')) {
        header = false
        return ['@@']
      }
      if (line === 'GIT binary patch') {
        header = false
        return [line]
      }
      if (line.startsWith('Binary files ')) {
        header = false
        return ['Binary files differ']
      }
      if (
        header &&
        (line.startsWith('diff --git ') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ') ||
          line.startsWith('rename from ') ||
          line.startsWith('rename to ') ||
          line.startsWith('copy from ') ||
          line.startsWith('copy to '))
      ) {
        return []
      }
      return [line]
    })
    .join('\n')
  return new Bun.CryptoHasher('sha256').update(normalized).digest('hex')
}

type ExactHunksPatch = { exactHunksId?: string }

/** Compare contextual per-path patch identities; absent identities never match. */
export function sameExactHunks(
  reviewed: ExactHunksPatch | null | undefined,
  current: ExactHunksPatch | null | undefined,
): boolean {
  return (
    reviewed?.exactHunksId !== undefined &&
    current?.exactHunksId !== undefined &&
    reviewed.exactHunksId === current.exactHunksId
  )
}

/** Turn one persisted change tuple into facts without letting malformed path data match. */
export function storedChangeFacts(row: {
  patchId: string | null
  zeroContextPatchId: string | null
  pathSet: string | null
  message?: string | null
}): ChangeFacts {
  let paths: readonly string[] | null = null
  if (row.pathSet !== null) {
    try {
      const parsed: unknown = JSON.parse(row.pathSet)
      if (Array.isArray(parsed) && parsed.every((path) => typeof path === 'string')) paths = parsed
    } catch {
      // An unreadable stored path set cannot establish review coverage.
    }
  }
  return {
    patchId: row.patchId,
    zeroContextPatchId: row.zeroContextPatchId,
    paths,
    message: row.message ?? null,
  }
}

/**
 * The only in-memory decision for comparing persisted and current change identities.
 * `replayWitnessForCurrent` is the only adapter-side shortcut around this decision.
 */
export function sameChange(facts: SameChangeFacts): SameChangeDecision {
  const messageChanged = facts.reviewed.message !== facts.current.message
  if (facts.reviewed.paths === null || facts.current.paths === null) {
    return {
      same: false,
      basis: 'different',
      messageChanged,
      reason: 'path set unavailable',
    }
  }
  const pathsMatch = samePaths(facts.reviewed.paths, facts.current.paths)
  if (
    pathsMatch &&
    facts.reviewed.zeroContextPatchId !== null &&
    facts.current.zeroContextPatchId !== null &&
    facts.reviewed.zeroContextPatchId === facts.current.zeroContextPatchId
  ) {
    return { same: true, basis: 'zero-context', messageChanged, reason: null }
  }
  if (
    pathsMatch &&
    (facts.reviewed.zeroContextPatchId === null || facts.current.zeroContextPatchId === null) &&
    facts.reviewed.patchId !== null &&
    facts.reviewed.patchId === facts.current.patchId
  ) {
    return { same: true, basis: 'legacy', messageChanged, reason: null }
  }
  if (facts.replay?.kind === 'same-tree') {
    return { same: true, basis: 'replay', messageChanged, reason: null }
  }
  const reason =
    facts.replay?.kind === 'unavailable'
      ? facts.replay.reason
      : facts.replay?.kind === 'conflict'
        ? 'change replay conflicted'
        : pathsMatch
          ? 'change identity differs'
          : 'path set differs'
  return { same: false, basis: 'different', messageChanged, reason }
}

/** Compare two persisted change tuples without a Git replay witness. */
export function sameStoredChange(reviewed: StoredChangeRow, current: StoredChangeRow): boolean {
  return sameChange({
    reviewed: storedChangeFacts(reviewed),
    current: storedChangeFacts(current),
    replay: null,
  }).same
}

/** Match a stored identity, including an adapter-gathered clean-replay witness. */
export function sameStoredChangeOrWitness(
  reviewed: StoredChangeRow & { replayMatchesCurrent?: boolean },
  current: StoredChangeRow,
): boolean {
  return sameStoredChange(reviewed, current) || reviewed.replayMatchesCurrent === true
}
