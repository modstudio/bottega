const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}

export const decodeTrackerText = (value: string) =>
  value.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (match) => ENTITIES[match] ?? match)

export function reportedParentKey(
  row: { parent?: unknown },
  keyField: 'short_id' | 'humanKey' | 'key',
): string | null | undefined {
  if (!('parent' in row)) return undefined
  if (!row.parent || typeof row.parent !== 'object') return null
  const key = (row.parent as Record<string, unknown>)[keyField]
  return typeof key === 'string' && key.trim() ? key.toUpperCase() : null
}
