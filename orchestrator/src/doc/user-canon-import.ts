// concern: user-canon-import
/** Mirrors one hosted user-canon import transaction into one local transaction. */
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { type RecordUserCanonImportResult, recordApiClient } from '../record/record-api-client.ts'
import type { Doc } from './doc-read-store.ts'
import { listDocsStore } from './doc-read-store.ts'
import {
  assertLocalRevisionWrite,
  docWriteIdentity,
  insertLocalRevision,
} from './doc-revision-store.ts'

export type UserCanonImportRow = { slug: string; title: string; body: string }

export async function importUserCanon(input: {
  owner: string
  rows: UserCanonImportRow[]
  reason: string
  author?: string
}): Promise<RecordUserCanonImportResult> {
  writableDb()
  const identity = docWriteIdentity(input)
  const current = listDocsStore({ scope: 'canon', subject: null, owner: input.owner })
  for (const row of current) {
    assertLocalRevisionWrite(
      { scope: 'canon', expectedRevision: row.revision ?? undefined },
      row.revision,
      false,
    )
  }
  const expectedRevisions = Object.fromEntries(
    current.flatMap((row) => (row.revision ? [[row.slug, row.revision]] : [])),
  )
  const hosted = await recordApiClient().importUserCanon({
    rows: input.rows,
    expectedRevisions,
    reason: identity.reason,
    author: identity.author,
  })
  return writeTransaction(() => {
    const live = listDocsStore({ scope: 'canon', subject: null, owner: input.owner })
    const liveBySlug = new Map(live.map((row) => [row.slug, row]))
    for (const row of current) {
      const existing = liveBySlug.get(row.slug)
      assertLocalRevisionWrite(
        { scope: 'canon', expectedRevision: row.revision ?? undefined },
        existing?.revision ?? null,
        existing === undefined,
      )
    }
    const at = nowIso()
    for (const result of hosted.rows) {
      const row = input.rows.find(({ slug }) => slug === result.slug)!
      const existing = liveBySlug.get(row.slug)
      let stored: Doc
      if (existing) {
        db()
          .query('UPDATE doc SET title=?, body=?, delivery=?, updated_at=?, record_id=? WHERE id=?')
          .run(row.title, row.body, 'demand', at, result.id, existing.id)
        stored = { ...existing, title: row.title, body: row.body, record_id: result.id }
      } else {
        const inserted = db()
          .query(
            `INSERT INTO doc
             (scope, subject, owner, project_id, slug, title, body, delivery, created_at, updated_at, record_id)
             VALUES ('canon',NULL,?,NULL,?,?,?,'demand',?,?,?) RETURNING id`,
          )
          .get(input.owner, row.slug, row.title, row.body, at, at, result.id) as { id: number }
        stored = db().query('SELECT * FROM doc WHERE id=?').get(inserted.id) as Doc
      }
      insertLocalRevision(stored, 'import', identity, at, result.revisionId)
    }
    for (const result of hosted.deletions) {
      const existing = liveBySlug.get(result.slug)
      if (!existing) throw new Error(`no user canon doc "${result.slug}"`)
      db().query('DELETE FROM doc WHERE id=?').run(existing.id)
      insertLocalRevision(existing, 'delete', identity, at, result.revisionId)
    }
    return hosted
  })
}
