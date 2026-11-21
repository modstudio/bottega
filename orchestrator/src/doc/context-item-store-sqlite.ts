// concern: context-item-store-sqlite
/** Owns local context-item persistence. Context policy belongs to doc-context-write. */
import type { Database } from 'bun:sqlite'
import {
  type ContextHolderKind,
  type ContextItemHolderGroup,
  type ContextItemKind,
  contextItemHolderGroup,
  type StoredContextItem,
  splitContextHolder,
} from '../../../shared/context-item-vocabulary.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'

type ContextItemRow = {
  record_id: string
  holder_kind: ContextHolderKind
  holder_id: string
  slug: string
  kind: ContextItemKind
  body: string
  source: string
  question_number: number | null
  target: string | null
  created_at: string
  updated_at: string
}

function stored(row: ContextItemRow): StoredContextItem {
  return {
    holder: `${row.holder_kind}:${row.holder_id}`,
    id: row.slug,
    recordId: row.record_id,
    kind: row.kind,
    body: row.body,
    source: row.source,
    questionNumber: row.question_number,
    target: row.target,
    revision: row.updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listLocalContextItems(
  holder: string,
  database: Database = db(),
): StoredContextItem[] {
  const { holderKind, holderId } = splitContextHolder(holder)
  return database
    .query<ContextItemRow, [string, string]>(
      'SELECT * FROM context_item WHERE holder_kind=? AND holder_id=? ORDER BY slug',
    )
    .all(holderKind, holderId)
    .map(stored)
}

export function getLocalContextItem(
  holder: string,
  slug: string,
  database: Database = db(),
): StoredContextItem | null {
  const { holderKind, holderId } = splitContextHolder(holder)
  const row = database
    .query<ContextItemRow, [string, string, string]>(
      'SELECT * FROM context_item WHERE holder_kind=? AND holder_id=? AND slug=?',
    )
    .get(holderKind, holderId, slug)
  return row ? stored(row) : null
}

export function listLocalContextHolders(
  holderKind: ContextItemRow['holder_kind'],
  database: Database = db(),
): ContextItemHolderGroup[] {
  const rows = database
    .query<ContextItemRow, [string]>(
      'SELECT * FROM context_item WHERE holder_kind=? ORDER BY holder_id,slug',
    )
    .all(holderKind)
  return [...Map.groupBy(rows, (row) => row.holder_id)].map(([holderId, items]) =>
    contextItemHolderGroup(`${holderKind}:${holderId}`, items.map(stored)),
  )
}

type SetContextItem = {
  holder: string
  slug: string
  kind: ContextItemKind
  body: string
  source: string
  questionNumber: number | null
  target: string | null
  expectedRevision?: string
  recordId?: string
  createdAt?: string
  updatedAt?: string
}

export function setLocalContextItem(input: SetContextItem): StoredContextItem {
  return writeTransaction(() => {
    const current = getLocalContextItem(input.holder, input.slug)
    if (input.expectedRevision !== undefined && input.expectedRevision !== current?.revision) {
      throw new Error(
        `context item ${input.holder}/${input.slug} changed; expected revision ${input.expectedRevision}, current revision ${current?.revision ?? 'missing'}`,
      )
    }
    const { holderKind, holderId } = splitContextHolder(input.holder)
    const at = input.updatedAt ?? nowIso()
    if (current) {
      db()
        .query(
          'UPDATE context_item SET kind=?,body=?,source=?,question_number=?,target=?,updated_at=? WHERE record_id=?',
        )
        .run(
          input.kind,
          input.body,
          input.source,
          input.questionNumber,
          input.target,
          at,
          current.recordId,
        )
    } else {
      db()
        .query(
          'INSERT INTO context_item(record_id,holder_kind,holder_id,slug,kind,body,source,question_number,target,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          input.recordId ?? newRecordId(),
          holderKind,
          holderId,
          input.slug,
          input.kind,
          input.body,
          input.source,
          input.questionNumber,
          input.target,
          input.createdAt ?? at,
          at,
        )
    }
    return getLocalContextItem(input.holder, input.slug)!
  })
}

export function removeLocalContextItem(
  holder: string,
  slug: string,
  expectedRevision?: string,
): boolean {
  return writeTransaction(() => {
    const current = getLocalContextItem(holder, slug)
    if (!current) return false
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new Error(
        `context item ${holder}/${slug} changed; expected revision ${expectedRevision}, current revision ${current.revision}`,
      )
    }
    db().query('DELETE FROM context_item WHERE record_id=?').run(current.recordId)
    return true
  })
}

export function removeLocalContextHolder(holder: string): number {
  const { holderKind, holderId } = splitContextHolder(holder)
  return db()
    .query('DELETE FROM context_item WHERE holder_kind=? AND holder_id=?')
    .run(holderKind, holderId).changes
}
