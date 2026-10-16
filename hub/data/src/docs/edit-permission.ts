import { parseRecordSpaceMemberships } from '../../../../shared/record-space-membership.ts'
import { recordSpaceAccessDecision } from '../../../../shared/record-space-request.ts'

/** Whether the signed-in reader may write the space that owns a hosted document. */
export function canEditHostedDoc(
  memberships: readonly Record<string, unknown>[] | undefined,
  documentSpaceId: string | undefined,
): boolean {
  if (!documentSpaceId) return false
  const parsed = parseRecordSpaceMemberships(memberships)
  return recordSpaceAccessDecision('write', documentSpaceId, parsed).allowed
}

export function canEditDoc(
  source: 'local' | 'hosted' | 'public',
  memberships: readonly Record<string, unknown>[] | undefined,
  documentSpaceId: string | undefined,
): boolean {
  if (source === 'local') return true
  return source === 'hosted' && canEditHostedDoc(memberships, documentSpaceId)
}
