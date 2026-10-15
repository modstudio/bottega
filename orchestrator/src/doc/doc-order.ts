// concern: doc-order
/** Pure validation for replacing one complete sibling order. */

export type DocOrderInput = {
  scope: string
  subject: string | null
  parentId: string | null
  orderedIds: string[]
}

export type LocalDocOrderRow = { id: number; slug: string; record_id: string | null }

export function localDocId(id: string): number {
  const parsed = Number(id)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`refusing document reorder: id "${id}" is not a positive integer`)
  }
  return parsed
}

export function hostedDocOrder(
  input: DocOrderInput,
  siblings: readonly LocalDocOrderRow[],
  parent: LocalDocOrderRow | null,
  missingRecordIdRemedy: string,
): DocOrderInput {
  const byId = new Map(siblings.map((doc) => [doc.id, doc]))
  const translated = input.orderedIds.map((id) => {
    const doc = byId.get(localDocId(id))
    if (!doc) throw new Error(`refusing document reorder: local document id "${id}" was not found`)
    if (!doc.record_id) {
      throw new Error(
        `document "${doc.slug}" has no hosted record id; cleared by: ${missingRecordIdRemedy}`,
      )
    }
    return doc.record_id
  })
  if (input.parentId !== null && !parent) {
    throw new Error(`refusing document reorder: local parent id "${input.parentId}" was not found`)
  }
  if (parent && !parent.record_id) {
    throw new Error(
      `parent "${parent.slug}" has no hosted record id; cleared by: ${missingRecordIdRemedy}`,
    )
  }
  return { ...input, parentId: parent?.record_id ?? null, orderedIds: translated }
}

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
