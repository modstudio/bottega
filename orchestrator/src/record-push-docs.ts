// concern: record-push-docs
/** One-time upload of the local doc store and a verdict count report. Must not know HTTP internals. */
import { db } from './db.ts'
import type { DocRevisionOp } from './doc-write-allowed.ts'
import { recordApiClient } from './record-api-client.ts'

type Presentation = { log(value: string): void }

export async function pushDocsCommand(
  options: { dryRun: boolean },
  presentation: Presentation,
): Promise<void> {
  const local = db()
  const docs = local
    .query<
      {
        id: number
        record_id: string | null
        scope: string
        subject: string | null
        slug: string
        title: string
        body: string
        delivery: 'inject' | 'demand'
      },
      []
    >('SELECT id, record_id, scope, subject, slug, title, body, delivery FROM doc ORDER BY id')
    .all()
  const revisions = local
    .query<
      {
        id: number
        doc_id: number
        record_id: string | null
        scope: string
        subject: string | null
        slug: string
        op: DocRevisionOp
        title: string
        body: string
        delivery: 'inject' | 'demand'
        author: string
        reason: string
        at: string
      },
      []
    >(
      'SELECT id, doc_id, record_id, scope, subject, slug, op, title, body, delivery, author, reason, at FROM doc_revision ORDER BY id',
    )
    .all()
  const localScores = local.query<{ n: number }, []>('SELECT count(*) AS n FROM score').get()!.n
  const localVoids = local
    .query<{ n: number }, []>('SELECT count(*) AS n FROM run WHERE evidence_excluded IS NOT NULL')
    .get()!.n
  presentation.log(
    `local docs ${docs.length}, revisions ${revisions.length}, scores ${localScores}, voids ${localVoids}`,
  )
  if (options.dryRun) return
  const client = recordApiClient()
  const docIds = new Map<number, string>()
  for (const doc of docs) {
    const hosted = await client.upsertDoc({
      scope: doc.scope,
      subject: doc.subject,
      slug: doc.slug,
      title: doc.title,
      body: doc.body,
      delivery: doc.delivery,
      reason: 'record push-docs',
      author: 'record-push-docs',
      op: 'set',
      id: doc.record_id ?? undefined,
    })
    docIds.set(doc.id, hosted.id)
    if (doc.record_id !== hosted.id) {
      local.query('UPDATE doc SET record_id=? WHERE id=?').run(hosted.id, doc.id)
    }
  }
  for (const revision of revisions) {
    if (revision.record_id) continue
    const docId = docIds.get(revision.doc_id)
    const hosted = await client.upsertDoc({
      scope: revision.scope,
      subject: revision.subject,
      slug: revision.slug,
      title: revision.title,
      body: revision.body,
      delivery: revision.delivery,
      reason: revision.reason,
      author: revision.author,
      op: revision.op,
      at: revision.at,
      id: docId,
      revisionId: revision.record_id ?? undefined,
    })
    local
      .query('UPDATE doc_revision SET record_id=? WHERE id=?')
      .run(hosted.revisionId, revision.id)
    if (docId !== hosted.id) {
      local.query('UPDATE doc SET record_id=? WHERE id=?').run(hosted.id, revision.doc_id)
      docIds.set(revision.doc_id, hosted.id)
    }
  }
  const hosted = await client.counts()
  presentation.log(
    `hosted docs ${hosted.docs}, revisions ${hosted.revisions}, scores ${hosted.scores}, voids ${hosted.voids}`,
  )
}
