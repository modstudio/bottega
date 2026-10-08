import type { SQL } from 'bun'
import type { DocStatus } from '../../../shared/docs.ts'
import { documentLifecycleDecision, resolvedReplacementSlug } from '../doc/doc-status.ts'
import { assertWrite, RecordDocError } from './record-doc-errors.ts'

type LifecycleAddress = {
  spaceId: string
  scope: string
  subject: string | null
  owner?: string | null
  slug: string
}

async function replacementExists(
  tx: SQL,
  input: LifecycleAddress,
  replacementSlug: string | null,
): Promise<boolean> {
  if (replacementSlug == null) return true
  const rows =
    await tx`SELECT id FROM doc WHERE space_id=${input.spaceId}::uuid AND scope=${input.scope} AND COALESCE(subject, '')=${input.subject ?? ''} AND COALESCE(owner_user_id::text, '')=${input.owner ?? ''} AND slug=${replacementSlug} AND deleted_at IS NULL`
  return Boolean(rows[0])
}

export async function recordDocumentLifecycle(
  tx: SQL,
  input: LifecycleAddress & { status?: DocStatus; replacementSlug?: string | null },
  prior?: { status?: unknown; replacement_slug?: unknown },
) {
  const priorReplacement = prior?.replacement_slug == null ? null : String(prior.replacement_slug)
  const lifecycle = {
    scope: input.scope,
    subject: input.subject,
    slug: input.slug,
    requestedStatus: input.status,
    requestedReplacementSlug: input.replacementSlug,
    priorStatus: prior?.status == null ? undefined : (String(prior.status) as DocStatus),
    priorReplacementSlug: priorReplacement,
  }
  const replacementSlug = resolvedReplacementSlug(lifecycle)
  const decision = documentLifecycleDecision({
    ...lifecycle,
    replacementExists: await replacementExists(tx, input, replacementSlug),
  })
  if (decision.refusal !== null) throw new RecordDocError(decision.refusal)
  return decision
}

export async function validateImportedDocumentLifecycles(
  tx: SQL,
  input: LifecycleAddress,
  snapshots: Array<{ status: DocStatus; replacementSlug: string | null }>,
): Promise<void> {
  for (const snapshot of snapshots) {
    const decision = documentLifecycleDecision({
      scope: input.scope,
      subject: input.subject,
      slug: input.slug,
      requestedStatus: snapshot.status,
      requestedReplacementSlug: snapshot.replacementSlug,
      replacementExists: await replacementExists(tx, input, snapshot.replacementSlug),
    })
    assertWrite(decision.refusal)
  }
}
