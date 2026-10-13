// concern: record-doc-list-shape
/** Decodes hosted document list columns without hiding a persisted wrong shape. */

export function recordDocList(
  value: unknown,
  input: { document: string; column: string; optional?: boolean },
): { values: unknown[]; unwrapped: boolean } {
  if (Array.isArray(value)) return { values: value, unwrapped: false }
  if (value == null && input.optional) return { values: [], unwrapped: false }
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
      return { values: parsed, unwrapped: true }
    }
  }
  throw new Error(`hosted document ${input.document} column ${input.column} is not a JSON list`)
}
