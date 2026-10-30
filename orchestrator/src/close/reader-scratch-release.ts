// concern: reader clone release
/** Pure decisions for terminal reader clones. Must not know git, files, or storage. */
export type ReaderCloneReleaseFacts = {
  readOnlyJob: boolean
  terminal: boolean
  treeAbsent: boolean
  provablyDisposable: boolean
  archiveSucceeded: boolean | null
}
export type ReaderCloneReleaseAction =
  | 'ordinary'
  | 'keep'
  | 'remove'
  | 'archive-then-release'
  | 'release'

export function readerCloneReleaseDecision(
  facts: ReaderCloneReleaseFacts,
): ReaderCloneReleaseAction {
  if (!facts.terminal) return 'keep'
  if (!facts.readOnlyJob || facts.treeAbsent) return 'ordinary'
  if (facts.provablyDisposable) return 'remove'
  if (facts.archiveSucceeded === null) return 'archive-then-release'
  return facts.archiveSucceeded ? 'release' : 'keep'
}

export type ReaderCloneArchiveRetentionFacts = {
  nowMs: number
  modifiedMs: number
  retentionDays: number
}

export type ReaderCloneArchive = { path: string; archivedMs: number }

export function formatReaderCloneArchiveStamp(now: Date): string {
  return now.toISOString().replaceAll(':', '').replaceAll('.', '')
}

export function parseReaderCloneArchiveStamp(path: string): number | null {
  const match = path.match(/-(\d{4}-\d{2}-\d{2}T)(\d{2})(\d{2})(\d{2})(\d{3})Z$/)
  if (!match) return null
  const archivedMs = Date.parse(`${match[1]}${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  return Number.isNaN(archivedMs) ? null : archivedMs
}

export function readerCloneArchiveRetentionDecision(
  facts: ReaderCloneArchiveRetentionFacts,
): 'delete' | 'keep' {
  const ageMs = Math.max(0, facts.nowMs - facts.modifiedMs)
  return ageMs > facts.retentionDays * 86_400_000 ? 'delete' : 'keep'
}

/** Select the bounded oldest-first batch of expired archives for this sweep. */
export function readerCloneArchivePruneDecision(input: {
  archives: readonly ReaderCloneArchive[]
  nowMs: number
  retentionDays: number
  deletionCap: number
}): { delete: string[]; deferred: number } {
  const expired = input.archives
    .filter(
      (archive) =>
        readerCloneArchiveRetentionDecision({
          nowMs: input.nowMs,
          modifiedMs: archive.archivedMs,
          retentionDays: input.retentionDays,
        }) === 'delete',
    )
    .sort((left, right) => left.archivedMs - right.archivedMs)
  return {
    delete: expired.slice(0, input.deletionCap).map((archive) => archive.path),
    deferred: Math.max(0, expired.length - input.deletionCap),
  }
}
