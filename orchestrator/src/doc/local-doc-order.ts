// concern: local-doc-order
/** Reorders one complete local document sibling list without changing document revisions. */

import { db, writeTransaction } from '../database/db.ts'
import { type DocOrderInput, docOrderRefusal } from './doc-order.ts'
import { referenceOrderRefusal } from './doc-write-allowed.ts'

export function executeLocalDocOrder(input: DocOrderInput): { orderedIds: string[] } {
  return writeTransaction(() => {
    if (input.parentId !== null) {
      const parent = db()
        .query<{ form: string | null }, [string]>('SELECT form FROM doc WHERE record_id=?')
        .get(input.parentId)
      const referenceRefusal = referenceOrderRefusal(parent?.form)
      if (referenceRefusal) throw new Error(referenceRefusal)
    }
    const current = db()
      .query<{ record_id: string }, [string, string, string | null]>(
        `SELECT record_id FROM doc
         WHERE scope=? AND COALESCE(subject, '')=? AND parent_record_id IS ?
         ORDER BY position, title, record_id`,
      )
      .all(input.scope, input.subject ?? '', input.parentId)
      .map((row) => row.record_id)
    const refusal = docOrderRefusal(current, input.orderedIds)
    if (refusal) throw new Error(refusal)
    const update = db().query('UPDATE doc SET position=? WHERE record_id=?')
    for (const [position, id] of input.orderedIds.entries()) update.run(position, id)
    return { orderedIds: input.orderedIds }
  })
}
