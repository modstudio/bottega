// concern: local-doc-order
/** Reorders one complete local document sibling list without changing document revisions. */

import { db, writeTransaction } from '../database/db.ts'
import { type DocOrderInput, docOrderRefusal, localDocId } from './doc-order.ts'

export function executeLocalDocOrder(input: DocOrderInput): { orderedIds: string[] } {
  const ordered = input.orderedIds.map(localDocId)
  return writeTransaction(() => {
    const current = db()
      .query<{ id: number }, [string, string, number | null]>(
        `SELECT id FROM doc
         WHERE scope=? AND COALESCE(subject, '')=? AND parent_id IS ?
         ORDER BY position, title, id`,
      )
      .all(
        input.scope,
        input.subject ?? '',
        input.parentId === null ? null : localDocId(input.parentId),
      )
      .map((row) => String(row.id))
    const refusal = docOrderRefusal(current, input.orderedIds)
    if (refusal) throw new Error(refusal)
    const update = db().query('UPDATE doc SET position=? WHERE id=?')
    for (const [position, id] of ordered.entries()) update.run(position, id)
    return { orderedIds: input.orderedIds }
  })
}
