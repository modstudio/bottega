// concern: local-document-write-execution
/**
 * Executes local-authoritative document mutations and commits document results locally.
 * Knows the local document and revision stores; must not know hosted transport, write gates, or CLI.
 */

import type { DocAudience } from '../../../shared/docs.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import type { Doc } from './doc-read-store.ts'
import {
  assertLocalRevisionWrite,
  currentDocRevision,
  insertLocalRevision,
} from './doc-revision-store.ts'
import type { DocRevisionOp } from './doc-write-allowed.ts'

type WriteIdentity = { author: string; reason: string; session: string | null }
type Address = {
  scope: string
  subject: string | null
  owner: string | null
  slug: string
}

const LATEST_REVISION_SQL =
  '(SELECT r.record_id FROM doc_revision r WHERE r.doc_id=d.id ORDER BY r.id DESC LIMIT 1)'

function getDoc(input: Address): Doc | null {
  return db()
    .query(
      `SELECT d.*, p.slug AS parent_slug, ${LATEST_REVISION_SQL} AS revision FROM doc d LEFT JOIN doc p ON p.id=d.parent_id WHERE d.scope=? AND d.subject IS ? AND d.owner IS ? AND d.slug=?`,
    )
    .get(input.scope, input.subject, input.owner, input.slug) as Doc | null
}

type SetInput = Address & {
  projectId: number | null
  title: string
  body: string
  delivery: 'inject' | 'demand'
  audience: DocAudience
  parentId: number | null
  position: number
  expectedRevision?: string
  requestedOp?: Extract<DocRevisionOp, 'import'>
  identity: WriteIdentity
}

export function executeLocalDocSet(input: SetInput & { prior: Doc | null }): Doc {
  return commitDocSet({
    ...input,
    recordId: input.prior?.record_id ?? newRecordId(),
    revisionId: newRecordId(),
  })
}

export function commitDocSet(input: SetInput & { recordId: string; revisionId: string }): Doc {
  return writeTransaction(() => {
    const existing = getDoc(input)
    assertLocalRevisionWrite(input, existing?.revision ?? null, existing === null)
    const at = nowIso()
    if (existing) {
      db()
        .query(
          'UPDATE doc SET project_id=?, title=?, body=?, delivery=?, audience=?, parent_id=?, position=?, updated_at=?, record_id=? WHERE id=?',
        )
        .run(
          input.projectId,
          input.title,
          input.body,
          input.delivery,
          input.audience,
          input.parentId,
          input.position,
          at,
          input.recordId,
          existing.id,
        )
    } else {
      db()
        .query(
          `INSERT INTO doc (scope, subject, owner, project_id, slug, title, body, delivery, audience, parent_id, position, created_at, updated_at, record_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.scope,
          input.subject,
          input.owner,
          input.projectId,
          input.slug,
          input.title,
          input.body,
          input.delivery,
          input.audience,
          input.parentId,
          input.position,
          at,
          at,
          input.recordId,
        )
    }
    const doc = getDoc(input)!
    insertLocalRevision(
      doc,
      input.requestedOp ?? (existing ? 'set' : 'create'),
      input.identity,
      at,
      input.revisionId,
    )
    return getDoc(input)!
  })
}

type RemoveInput = Address & { expectedRevision?: string; identity: WriteIdentity }

export function executeLocalDocRemove(input: RemoveInput & { doc: Doc }): boolean {
  newRecordId()
  return commitDocRemove({ ...input, revisionId: newRecordId() })
}

export function commitDocRemove(input: RemoveInput & { revisionId: string }): boolean {
  return writeTransaction(() => {
    const existing = getDoc(input)
    if (!existing) throw new Error(`no ${input.scope} doc "${input.slug}"`)
    assertLocalRevisionWrite(input, existing.revision, false)
    const at = nowIso()
    db().query('DELETE FROM doc WHERE id=?').run(existing.id)
    insertLocalRevision(existing, 'delete', input.identity, at, input.revisionId)
    return true
  })
}

type ConsumeInput = Address & {
  body: string
  consumedAt: string
  expectedRevision?: string
  identity: WriteIdentity
}

export function executeLocalDocConsume(input: ConsumeInput & { doc: Doc }): Doc & {
  already_consumed: false
} {
  return commitDocConsume({
    ...input,
    recordId: input.doc.record_id ?? newRecordId(),
    revisionId: newRecordId(),
  })
}

export function commitDocConsume(
  input: ConsumeInput & { recordId: string; revisionId: string },
): Doc & { already_consumed: false } {
  return writeTransaction(() => {
    const existing = getDoc(input)
    if (!existing) throw new Error(`no ${input.scope} doc "${input.slug}"`)
    assertLocalRevisionWrite(input, existing.revision, false)
    db()
      .query('UPDATE doc SET body=?, updated_at=?, record_id=? WHERE id=?')
      .run(input.body, input.consumedAt, input.recordId, existing.id)
    const result = getDoc(input)!
    insertLocalRevision(result, 'consume', input.identity, input.consumedAt, input.revisionId)
    return { ...getDoc(input)!, already_consumed: false }
  })
}

type RestoreInput = Address & {
  projectId: number | null
  title: string
  body: string
  delivery: 'inject' | 'demand'
  audience: DocAudience
  parentId: number | null
  position: number
  expectedRevision?: string
  identity: WriteIdentity
}

export function executeLocalDocRestore(
  input: RestoreInput & { liveRecordId: string | null | undefined },
): Doc {
  return commitDocRestore({
    ...input,
    recordId: input.liveRecordId ?? newRecordId(),
    revisionId: newRecordId(),
  })
}

export function commitDocRestore(
  input: RestoreInput & { recordId: string; revisionId: string },
): Doc {
  return writeTransaction(() => {
    const existing = getDoc(input)
    assertLocalRevisionWrite(
      input,
      currentDocRevision(input.scope, input.subject, input.slug, input.owner),
      false,
    )
    const at = nowIso()
    if (existing) {
      db()
        .query(
          'UPDATE doc SET project_id=?, title=?, body=?, delivery=?, audience=?, parent_id=?, position=?, updated_at=?, record_id=? WHERE id=?',
        )
        .run(
          input.projectId,
          input.title,
          input.body,
          input.delivery,
          input.audience,
          input.parentId,
          input.position,
          at,
          input.recordId,
          existing.id,
        )
    } else {
      db()
        .query(
          `INSERT INTO doc (scope, subject, owner, project_id, slug, title, body, delivery, audience, parent_id, position, created_at, updated_at, record_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.scope,
          input.subject,
          input.owner,
          input.projectId,
          input.slug,
          input.title,
          input.body,
          input.delivery,
          input.audience,
          input.parentId,
          input.position,
          at,
          at,
          input.recordId,
        )
    }
    const doc = getDoc(input)!
    insertLocalRevision(doc, 'restore', input.identity, at, input.revisionId)
    return getDoc(input)!
  })
}
