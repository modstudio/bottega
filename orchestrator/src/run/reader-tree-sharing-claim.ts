// concern: claim-time reader tree sharing adapter
/** Gives claim and sandbox selection one ruling from their already-resolved facts. */

import { nowIso } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { projectAt } from '../project/projects.ts'
import { isReadonlySandboxCandidate } from '../sandbox/sandbox.ts'
import { appendProvisioningPhases } from '../worktree/provisioning-measurement.ts'
import { readerTreeSharing } from '../worktree/reader-tree-sharing.ts'
import { toolFor } from '../worktree/worktree-preflight.ts'

type ClaimSharingInput = {
  name: string
  writesJob: boolean
  repoJob: boolean
  reviewTarget: { commit: string } | null
  mcpRequest: unknown
  callerCwd: string
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
    projectRegistered: projectAt(input.callerCwd) !== null,
    readonlyRecipeDeclared: Boolean(toolFor(input.callerCwd)?.readonly_create),
  })
}

function recordSharedReaderFallback(runId: string, reason: string): void {
  const detail = reason.replaceAll('\n', ' ')
  appendProvisioningPhases(runId, [
    { phase: 'shared-reader-fallback', name: detail, durationMs: 0 },
  ])
  appendRunEvent(runId, {
    ts: nowIso(),
    type: 'text',
    text: `shared reader tree was not reusable; provisioned own tree: ${detail}`,
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
