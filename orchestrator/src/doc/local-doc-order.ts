// concern: local-doc-order
/** Reorders one complete local document sibling list without changing document revisions. */

import { db, writeTransaction } from '../database/db.ts'
import { type DocOrderInput, docOrderRefusal } from './doc-order.ts'
import { assertWorkerDocStoreWriteAllowed } from './doc-write-guard.ts'

function localDocId(id: string): number {
  const parsed = Number(id)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`refusing document reorder: id "${id}" is not a positive integer`)
  }
  return parsed
}

export type LocalDocOrderRow = { id: number; slug: string; record_id: string | null }

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

export function localDocOrderRows(input: DocOrderInput): LocalDocOrderRow[] {
  return db()
    .query<LocalDocOrderRow, [string, string, number | null]>(
      `SELECT id, slug, record_id FROM doc
       WHERE scope=? AND COALESCE(subject, '')=? AND parent_id IS ?
       ORDER BY position, title, id`,
    )
    .all(
      input.scope,
      input.subject ?? '',
      input.parentId === null ? null : localDocId(input.parentId),
    )
}

export function localDocOrderParent(parentId: string | null): LocalDocOrderRow | null {
  return parentId === null
    ? null
    : (db()
        .query<LocalDocOrderRow, [number]>('SELECT id, slug, record_id FROM doc WHERE id=?')
        .get(localDocId(parentId)) ?? null)
}

export function commitLocalDocOrder(input: DocOrderInput): { orderedIds: string[] } {
  assertWorkerDocStoreWriteAllowed('reorderLocalDocs')
  const ordered = input.orderedIds.map(localDocId)
  return writeTransaction(() => {
    const current = localDocOrderRows(input).map((row) => String(row.id))
    const refusal = docOrderRefusal(current, input.orderedIds)
    if (refusal) throw new Error(refusal)
    const update = db().query('UPDATE doc SET position=? WHERE id=?')
    for (const [position, id] of ordered.entries()) update.run(position, id)
    return { orderedIds: input.orderedIds }
  })
}
