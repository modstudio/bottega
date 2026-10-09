// concern: canon-import
/** Mirrors one hosted canon import transaction into one local transaction. */

import { newRecordId } from '../../../shared/record/schema.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import type { RecordCanonImportResult } from '../record/record-api-client.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { workerStoreWriteRefusal } from '../worker-store-write.ts'
import { nonCurrentCanonCollisionRefusal } from './canon-import-collision.ts'
import { hostedDocClient } from './doc-hosted-client.ts'
import type { Doc } from './doc-read-store.ts'
import { getDocStore, listDocsStore } from './doc-read-store.ts'
import {
  assertLocalRevisionWrite,
  docWriteIdentity,
  insertLocalRevision,
} from './doc-revision-store.ts'

export type CanonImportRow = { slug: string; title: string; body: string }
export type LocalCanonImportAddress =
  | { kind: 'user'; owner: string }
  | { kind: 'project'; subject: string; projectId: number }

export function hasCanonImportHistory(address: LocalCanonImportAddress): boolean {
  const subject = address.kind === 'project' ? address.subject : null
  const owner = address.kind === 'user' ? address.owner : null
  return (
    db()
      .query(
        `SELECT 1 FROM doc_revision
         WHERE scope='canon' AND subject IS ? AND owner IS ? LIMIT 1`,
      )
      .get(subject, owner) !== null
  )
}

export async function importCanon(input: {
  address: LocalCanonImportAddress
  rows: CanonImportRow[]
  reason: string
  author?: string
}): Promise<RecordCanonImportResult> {
  const refusal = workerStoreWriteRefusal('document', 'importCanon', process.env)
  if (refusal) throw new Error(refusal)
  writableDb()
  const identity = docWriteIdentity(input)
  const subject = input.address.kind === 'project' ? input.address.subject : null
  const owner = input.address.kind === 'user' ? input.address.owner : null
  const projectId = input.address.kind === 'project' ? input.address.projectId : null
  const allRows = listDocsStore({ scope: 'canon', subject, owner })
  const collision = nonCurrentCanonCollisionRefusal({
    rows: allRows,
    desiredSlugs: input.rows.map((row) => row.slug),
    address: input.address,
  })
  if (collision) throw new Error(collision)
  const current = allRows.filter((row) => row.status === 'current')
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
  const hosted = await applyRecordWriteAuthority<RecordCanonImportResult>({
    local: () => ({
      rows: input.rows.map((row) => ({
        slug: row.slug,
        id: current.find((existing) => existing.slug === row.slug)?.record_id ?? newRecordId(),
        revisionId: newRecordId(),
      })),
      deletions: current
        .filter((row) => !input.rows.some((next) => next.slug === row.slug))
        .map((row) => ({
          slug: row.slug,
          id: row.record_id ?? newRecordId(),
          revisionId: newRecordId(),
        })),
      findings: [],
      bootstrap: !hasCanonImportHistory(input.address),
    }),
    hosted: async () => {
      const subject = input.address.kind === 'project' ? input.address.subject : null
      return (await hostedDocClient('canon', subject)).importCanon({
        address:
          input.address.kind === 'user'
            ? { kind: 'user' }
            : { kind: 'project', subject: input.address.subject },
        rows: input.rows,
        expectedRevisions,
        reason: identity.reason,
        author: identity.author,
      })
    },
  })
  return writeTransaction(() => {
    const live = listDocsStore({ scope: 'canon', subject, owner, status: 'current' })
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
        db()
          .query(
            `INSERT INTO doc
             (scope, subject, owner, project_id, slug, title, body, delivery, audiences, created_at, updated_at, record_id)
             VALUES ('canon',?,?,?, ?,?,?, 'demand','["technical"]',?,?,?)`,
          )
          .get(subject, owner, projectId, row.slug, row.title, row.body, at, at, result.id) as {
          id: number
        }
        stored = getDocStore('canon', subject, row.slug, owner)!
      }
      insertLocalRevision(stored, 'import', identity, at, result.revisionId)
    }
    for (const result of hosted.deletions) {
      const existing = liveBySlug.get(result.slug)
      if (!existing) throw new Error(`no canon doc "${result.slug}"`)
      db().query('DELETE FROM doc WHERE id=?').run(existing.id)
      insertLocalRevision(existing, 'delete', identity, at, result.revisionId)
    }
    return hosted
  })
}
