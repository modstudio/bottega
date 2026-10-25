// concern: resume brief author
/** Resolves the session that authored the current resume-brief lifecycle. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { currentRecordWriteDecision } from '../record/record-write-authority.ts'
import type { RecordWriteDecision } from '../record/record-write-decision.ts'
import { hostedDocClient } from './doc-hosted-client.ts'
import {
  latestStoredDocAuthorSession,
  storedDocRevisionAuthorSession,
} from './doc-revision-store.ts'
import type { ConsumedDoc, Doc } from './docs.ts'

type ResumeBriefHostedRevision = {
  id: string
  op: string
  sessionId: string | null
  at: string
}
export type ResumeBriefAuthorOptions = {
  writeDecision?: RecordWriteDecision
  listHostedRevisions?: (doc: Doc) => Promise<ResumeBriefHostedRevision[]>
}

export async function resumeBriefAuthorSession(
  doc: Doc | ConsumedDoc,
  database: Database = db(),
  options: ResumeBriefAuthorOptions = {},
): Promise<string | null> {
  const writeDecision = options.writeDecision ?? currentRecordWriteDecision(database)
  if (writeDecision !== 'hosted') return latestStoredDocAuthorSession(doc.record_id, database)
  let revisions: ResumeBriefHostedRevision[]
  try {
    revisions = options.listHostedRevisions
      ? await options.listHostedRevisions(doc)
      : ((await (
          await hostedDocClient(doc.scope, doc.subject)
        ).listRevisions(doc.record_id)) as ResumeBriefHostedRevision[])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `could not read hosted revisions for resume brief ${doc.subject}/${doc.slug}: ${message}; consume again when the hosted record is reachable`,
    )
  }
  const latest = revisions
    .filter((revision) => revision.op !== 'consume')
    .sort((left, right) => right.at.localeCompare(left.at))[0]
  if (!latest) return null
  if (latest.sessionId) return latest.sessionId
  return storedDocRevisionAuthorSession(latest.id, database)
}
