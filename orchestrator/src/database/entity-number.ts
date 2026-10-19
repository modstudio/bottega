// concern: database
/** Owns monotonic human-facing numbers for UUID-keyed entities. */

import type { Database } from 'bun:sqlite'

export type NumberedEntity = 'run' | 'question' | 'review'

/** Allocate a display number once. Deleting its eventual row never returns it. */
export function nextEntityNumber(database: Database, entity: NumberedEntity): number {
  const row = database
    .query<{ last_number: number }, [string, string]>(
      `UPDATE entity_number_counter
          SET last_number=MAX(last_number,
            CASE ? WHEN 'run' THEN COALESCE((SELECT MAX(number) FROM run),0)
                   WHEN 'question' THEN COALESCE((SELECT MAX(number) FROM question),0)
                   WHEN 'review' THEN COALESCE((SELECT MAX(number) FROM review),0) END)+1
        WHERE entity=? RETURNING last_number`,
    )
    .get(entity, entity)
  if (!row) throw new Error(`${entity} number counter is missing`)
  return row.last_number
}
