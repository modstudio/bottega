// concern: record-doc-list-shape
/** Decodes hosted document list columns without hiding a persisted wrong shape. */

let unwrappedStringLists = 0

export function recordDocList(
  value: unknown,
  input: { document: string; column: string; optional?: boolean },
): unknown[] {
  if (Array.isArray(value)) return value
  if (value == null && input.optional) return []
  if (typeof value === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error(
        `hosted document ${input.document} column ${input.column} is a string that does not contain a JSON list`,
      )
    }
    if (Array.isArray(parsed)) {
      unwrappedStringLists++
      console.warn(
        `unwrapped hosted document JSON string list #${unwrappedStringLists}: ${input.document} ${input.column}`,
      )
      return parsed
    }
  }
  throw new Error(`hosted document ${input.document} column ${input.column} is not a JSON list`)
}
