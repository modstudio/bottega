import {
  activeReviewFunnelPolicy,
  type VersionedReviewFunnelPolicy,
} from '../review-funnel/review-funnel-policy.ts'
import {
  type CanonMirrorRevisionSnapshot,
  canonMirrorRevisionSnapshot,
} from './canon-mirror-revisions.ts'
import { storedRepositoryCanonRows } from './canon-stored-rows.ts'

export type CanonMirrorRows = Awaited<ReturnType<typeof storedRepositoryCanonRows>>

export type CanonMirrorAuthoritativeSnapshot = {
  rows: CanonMirrorRows
  revisions: CanonMirrorRevisionSnapshot
  reviewPolicy: VersionedReviewFunnelPolicy
}

export type { VersionedReviewFunnelPolicy }

export async function canonMirrorAuthoritativeSnapshot(
  project: string,
): Promise<CanonMirrorAuthoritativeSnapshot> {
  try {
    const [rows, revisions, reviewPolicy] = await Promise.all([
      storedRepositoryCanonRows(project),
      canonMirrorRevisionSnapshot(project),
      activeReviewFunnelPolicy(),
    ])
    return { rows, revisions, reviewPolicy }
  } catch (cause) {
    throw new Error(
      `refusing canon mirror before taking the worktree lock: authoritative canon could not be read: ${String((cause as Error).message ?? cause)}; remedy: verify record access and retry canon mirror`,
    )
  }
}
