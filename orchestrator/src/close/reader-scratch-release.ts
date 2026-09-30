// concern: reader scratch release
/** Pure release decision for terminal reader clones. Must not know git, files, or storage. */

export type ReaderScratchReleaseFacts = {
  readOnlyJob: boolean
  terminal: boolean
  cloneDirty: boolean
  archiveSucceeded: boolean | null
}

export type ReaderScratchReleaseAction = 'release' | 'keep' | 'archive-then-release'

/** Decide whether a clone can be released, or first needs its reader scratch archived. */
export function readerScratchReleaseDecision(
  facts: ReaderScratchReleaseFacts,
): ReaderScratchReleaseAction {
  if (!facts.terminal) return 'keep'
  if (!facts.cloneDirty) return 'release'
  if (!facts.readOnlyJob) return 'keep'
  if (facts.archiveSucceeded === null) return 'archive-then-release'
  return facts.archiveSucceeded ? 'release' : 'keep'
}
