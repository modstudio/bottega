// concern: local-doc-revisions
/** Owns local revision ordering and compare-and-set facts. Must not know hosted transport or CLI. */

import type { DocAudience, DocStatus } from '../../../shared/docs.ts'
import { db, sessionId } from '../database/db.ts'
import { type DocRevisionOp, decideDocRevisionWrite } from './doc-write-allowed.ts'

type RevisionDoc = {
  id: number
  scope: string
  subject: string | null
  owner: string | null
  project_id: number | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  audience: DocAudience
  parent_id: number | null
  position: number
  featured: boolean
  status: DocStatus
  replacement_slug: string | null
}

export function docWriteIdentity(context: { author?: string; reason: string }): {
  author: string
  reason: string
  session: string | null
} {
  const reason = context.reason?.trim()
  if (!reason) {
    throw new Error(
      'doc write reason is required; pass --reason on the CLI or reason through MCP/Hub',
    )
  }
  const session = sessionId()
  const author = (context.author ?? session ?? 'unknown').trim()
  if (!author) {
    throw new Error('doc write author must not be empty; omit it to use the session or unknown')
  }
  return { author, reason, session }
}

export function assertLocalRevisionWrite(
  input: { scope: string; expectedRevision?: string },
  current: string | null,
  isCreate: boolean,
): void {
  const decision = decideDocRevisionWrite({
    expected: input.expectedRevision,
    current,
    isCreate,
    scope: input.scope,
  })
  if (!decision.allow) throw new Error(decision.reason)
}

export function currentDocRevision(
  scope: string,
  subject: string | null,
  slug: string,
  owner: string | null = null,
): string | null {
  const row = db()
    .query(
      'SELECT record_id FROM doc_revision WHERE scope=? AND subject IS ? AND owner IS ? AND slug=? ORDER BY id DESC LIMIT 1',
    )
    .get(scope, subject, owner, slug) as { record_id: string | null } | null
  return row?.record_id ?? null
}

export function insertLocalRevision(
  doc: RevisionDoc,
  op: DocRevisionOp,
  identity: { author: string; reason: string; session: string | null },
  at: string,
  recordId: string,
): void {
  db()
    .query(
      `INSERT INTO doc_revision
       (doc_id, scope, subject, owner, project_id, slug, op, title, body, delivery, audience, parent_id, position, featured, status, replacement_slug, author, reason, session_id, at, record_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      doc.id,
      doc.scope,
      doc.subject,
      doc.owner,
      doc.project_id,
      doc.slug,
      op,
      doc.title,
      doc.body,
      doc.delivery,
      doc.audience,
      doc.parent_id,
      doc.position,
      doc.featured,
      doc.status,
      doc.replacement_slug,
      identity.author,
      identity.reason,
      identity.session,
      at,
      recordId,
    )
}
