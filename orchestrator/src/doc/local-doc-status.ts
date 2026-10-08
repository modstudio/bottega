import type { DocStatus } from '../../../shared/docs.ts'
import type { Doc } from './doc-read-store.ts'
import { getDocStore } from './doc-read-store.ts'
import { documentLifecycleDecision } from './doc-status.ts'

export function localDocumentLifecycle(
  input: {
    scope: string
    subject: string | null
    slug: string
    owner?: string | null
    status?: DocStatus
    replacementSlug?: string | null
  },
  prior: Doc | null,
) {
  const replacementToCheck =
    input.replacementSlug ??
    (input.status === undefined || input.status === 'superseded' ? prior?.replacement_slug : null)
  const decision = documentLifecycleDecision({
    scope: input.scope,
    subject: input.subject,
    slug: input.slug,
    requestedStatus: input.status,
    requestedReplacementSlug: input.replacementSlug,
    priorStatus: prior?.status,
    priorReplacementSlug: prior?.replacement_slug,
    replacementExists:
      replacementToCheck == null ||
      Boolean(getDocStore(input.scope, input.subject, replacementToCheck, input.owner ?? null)),
  })
  if (decision.refusal !== null) throw new Error(decision.refusal)
  return decision
}
