// concern: claim-time reader tree sharing adapter
/** Gives claim and sandbox selection one ruling from their already-resolved facts. */

import { nowIso } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { isReadonlySandboxCandidate } from '../sandbox/sandbox.ts'
import { readerTreeSharing } from '../worktree/reader-tree-sharing.ts'

type ClaimSharingInput = {
  name: string
  writesJob: boolean
  repoJob: boolean
  reviewTarget: { commit: string } | null
  mcpRequest: unknown
  runProjectId: string | null
}

function readerTreeSharingForClaim(input: ClaimSharingInput): 'shared' | 'own' {
  return readerTreeSharing({
    writesRepo: input.writesJob,
    reviewCommit: input.reviewTarget?.commit ?? null,
    readonlySandboxCandidate: isReadonlySandboxCandidate({
      agent: input.name,
      readsRepo: input.repoJob,
      writesRepo: input.writesJob,
    }),
    mcpRequested: Boolean(input.mcpRequest),
    sandboxOverride: process.env.BOTTEGA_SANDBOX,
    projectRegistered: input.runProjectId !== null,
  })
}

function recordSharedReaderFallback(runId: string, reason: string): void {
  appendRunEvent(runId, {
    ts: nowIso(),
    type: 'text',
    text: `shared reader tree was not reusable; provisioned own tree: ${reason.replaceAll('\n', ' ')}`,
  })
}

export function readerTreeSharingOptions(
  input: ClaimSharingInput,
  runId: string,
): {
  sharedReviewCommit: string | undefined
  recordSharedFallback: (reason: string) => void
} {
  const sharing = readerTreeSharingForClaim(input)
  return {
    sharedReviewCommit: sharing === 'shared' ? input.reviewTarget!.commit : undefined,
    recordSharedFallback: (reason) => recordSharedReaderFallback(runId, reason),
  }
}
