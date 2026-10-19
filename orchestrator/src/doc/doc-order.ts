// concern: doc-order
/** Pure validation for replacing one complete sibling order. */

export type DocOrderInput = {
  scope: string
  subject: string | null
  parentId: string | null
  orderedIds: string[]
}

export type LocalDocOrderRow = { record_id: string; slug: string }

export function docOrderRefusal(
  currentIds: readonly string[],
  orderedIds: readonly string[],
): string | null {
  const current = new Set(currentIds)
  const ordered = new Set(orderedIds)
  const duplicates = orderedIds.filter((id, index) => orderedIds.indexOf(id) !== index)
  const missing = currentIds.filter((id) => !ordered.has(id))
  const unexpected = orderedIds.filter((id) => !current.has(id))
  if (
    !duplicates.length &&
    !missing.length &&
    !unexpected.length &&
    currentIds.length === orderedIds.length
  ) {
    return null
  }
  const details = [
    duplicates.length ? `duplicate ids: ${[...new Set(duplicates)].join(', ')}` : null,
    missing.length ? `missing ids: ${missing.join(', ')}` : null,
    unexpected.length ? `unexpected ids: ${unexpected.join(', ')}` : null,
  ].filter(Boolean)
  return `refusing document reorder: orderedIds is not exactly the current sibling set${details.length ? ` (${details.join('; ')})` : ''}`
}
