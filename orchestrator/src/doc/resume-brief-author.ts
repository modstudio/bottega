// concern: resume brief author
/** Resolves the session that authored the current resume-brief lifecycle. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { currentRecordWriteDecision } from '../record/record-write-authority.ts'
import { hostedDocClient } from './doc-hosted-client.ts'
import type { Doc } from './doc-read-store.ts'
import { latestStoredDocAuthorSession } from './doc-revision-store.ts'

export async function resumeBriefAuthorSession(
  doc: Doc,
  database: Database = db(),
): Promise<string | null> {
  const local = latestStoredDocAuthorSession(doc.record_id, database)
  if (local || currentRecordWriteDecision(database) !== 'hosted') return local
  const revisions = await (await hostedDocClient(doc.scope, doc.subject)).listRevisions(
    doc.record_id,
  )
  return (
    (revisions
      .filter(
        (revision) =>
          revision.op !== 'consume' &&
          typeof revision.sessionId === 'string' &&
          revision.sessionId,
      )
      .sort((left, right) => String(right.at).localeCompare(String(left.at)))[0]?.sessionId as
      | string
      | undefined) ?? null
  )
}
