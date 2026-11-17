// concern: database
/** Owns monotonic human-facing numbers for UUID-keyed entities. */

import type { Database } from 'bun:sqlite'

export type NumberedEntity = 'run' | 'question' | 'review' | 'board_message' | 'doc_revision'

const ALLOCATION_SQL: Record<NumberedEntity, string> = {
  run: `UPDATE entity_number_counter
           SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM run),0))+1
         WHERE entity=? RETURNING last_number`,
  question: `UPDATE entity_number_counter
                SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM question),0))+1
              WHERE entity=? RETURNING last_number`,
  review: `UPDATE entity_number_counter
              SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM review),0))+1
            WHERE entity=? RETURNING last_number`,
  board_message: `UPDATE entity_number_counter
                     SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM board_message),0))+1
                   WHERE entity=? RETURNING last_number`,
  doc_revision: `UPDATE entity_number_counter
                    SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM doc_revision),0))+1
                  WHERE entity=? RETURNING last_number`,
}

/** Allocate a display number once. Deleting its eventual row never returns it. */
export function nextEntityNumber(database: Database, entity: NumberedEntity): number {
  const row = database.query<{ last_number: number }, [string]>(ALLOCATION_SQL[entity]).get(entity)
  if (!row) throw new Error(`${entity} number counter is missing`)
  return row.last_number
}
