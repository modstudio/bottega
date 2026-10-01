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

export function readerCloneArchiveRetentionDecision(
  facts: ReaderCloneArchiveRetentionFacts,
): 'delete' | 'keep' {
  const ageMs = Math.max(0, facts.nowMs - facts.modifiedMs)
  return ageMs > facts.retentionDays * 86_400_000 ? 'delete' : 'keep'
}
