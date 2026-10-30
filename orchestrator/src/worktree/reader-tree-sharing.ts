// concern: reader-tree-sharing
/** Decides whether one repository reader may join the confined review tree. */

export type ReaderTreeSharingFacts = {
  writesRepo: boolean
  reviewCommit: string | null
  readonlySandboxCandidate: boolean
  mcpRequested: boolean
  sandboxOverride: string | undefined
  projectRegistered: boolean
  readonlyRecipeDeclared: boolean
}

export function readerTreeSharing(facts: ReaderTreeSharingFacts): 'shared' | 'own' {
  return !facts.writesRepo &&
    facts.reviewCommit !== null &&
    facts.readonlySandboxCandidate &&
    !facts.mcpRequested &&
    facts.sandboxOverride !== 'host' &&
    facts.projectRegistered &&
    !facts.readonlyRecipeDeclared
    ? 'shared'
    : 'own'
}
