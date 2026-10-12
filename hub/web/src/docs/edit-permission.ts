/** Whether the signed-in reader may write the space that owns a hosted document. */
export function canEditHostedDoc(
  memberships: readonly Record<string, unknown>[] | undefined,
  documentSpaceId: string | undefined,
): boolean {
  if (!documentSpaceId) return false
  return Boolean(
    memberships?.some(
      (membership) => membership.space_id === documentSpaceId && membership.permission === 'write',
    ),
  )
}
