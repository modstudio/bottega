/** The spaces a signed-in identity belongs to, read from its memberships. */
export function recordSpaces(
  memberships: readonly Record<string, unknown>[] | undefined,
): { id: string; name: string }[] {
  return (memberships ?? []).flatMap((membership) => {
    const id = membership.space_id
    const name = membership.name
    return typeof id === 'string' && typeof name === 'string' ? [{ id, name }] : []
  })
}
