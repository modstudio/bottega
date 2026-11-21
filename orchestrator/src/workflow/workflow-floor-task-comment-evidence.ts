// concern: workflows
/** Resolves a tracker comment offered as mutable workflow floor evidence. */

import type { ArtifactEvidence, ArtifactRef } from './workflow-artifact-reference.ts'
import { timedTaskCommentFreshnessNotice } from './workflow-floor-artifact-freshness.ts'
import type { HubTaskRead } from './workflow-floor-task-read.ts'

export function resolveTaskCommentArtifact(
  ref: Extract<ArtifactRef, { kind: 'comment' }>,
  raw: string,
  task: HubTaskRead,
  stepActivatedAt: string,
): ArtifactEvidence {
  if (task.commentsVerifiable === false)
    throw new Error(
      `--artifact ${raw} cannot be verified because this tracker's task read does not report comment ids; use --artifact task:${ref.key} to verify the task instead`,
    )
  if (!task.commentIds.map(String).includes(ref.id))
    throw new Error(`--artifact ${raw} is not a comment on ${ref.key}`)
  const notice = timedTaskCommentFreshnessNotice(task.commentWrittenAt?.[ref.id], stepActivatedAt)
  return { ref: raw, exists: true, ...(notice ? { notice } : {}) }
}
