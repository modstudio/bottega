// concern: identity-patch-manifest
/** Declares Git-issued change identities that are values rather than row references. */

import type { KeyStore, ManifestColumn } from './identity-inventory.ts'

const columns = [
  'landing_override.patch_id',
  'landing_override.zero_context_patch_id',
  'landing_review_carry.patch_id',
  'landing_review_carry.zero_context_patch_id',
  'landing_triage_snapshot.patch_id',
  'landing_triage_snapshot.zero_context_patch_id',
  'review.patch_id',
  'review.zero_context_patch_id',
  'review_read.patch_id',
  'review_read.zero_context_patch_id',
  'review_funnel_decision.patch_id',
  'review_funnel_decision.zero_context_patch_id',
] as const

export const PATCH_IDENTIFIERS: readonly ManifestColumn[] = (
  ['orchestrator', 'hosted'] satisfies KeyStore[]
).flatMap((store) =>
  columns.map((column) => ({
    store,
    column,
    reason: "identifier issued by Git's patch-id system",
  })),
)
