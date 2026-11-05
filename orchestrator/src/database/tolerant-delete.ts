import type { Database } from 'bun:sqlite'

/** Run a DELETE and report a foreign-key restriction without hiding other failures. */
export function tolerantDelete(
  statement: ReturnType<Database['query']>,
  ...bindings: unknown[]
): boolean {
  try {
    statement.run(...(bindings as never[]))
    return true
  } catch (error) {
    if (String(error).includes('FOREIGN KEY constraint failed')) return false
    throw error
  }
}
