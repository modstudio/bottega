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

type HostedRevision = Record<string, unknown>
export type ResumeBriefAuthorOptions = {
  writeDecision?: RecordWriteDecision
  listHostedRevisions?: (doc: Doc) => Promise<HostedRevision[]>
}

export async function resumeBriefAuthorSession(
  doc: Doc | ConsumedDoc,
  database: Database = db(),
  options: ResumeBriefAuthorOptions = {},
): Promise<string | null> {
  const writeDecision = options.writeDecision ?? currentRecordWriteDecision(database)
  if (writeDecision !== 'hosted') return latestStoredDocAuthorSession(doc.record_id, database)
  let revisions: HostedRevision[]
  try {
    revisions = options.listHostedRevisions
      ? await options.listHostedRevisions(doc)
      : await (await hostedDocClient(doc.scope, doc.subject)).listRevisions(doc.record_id)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `could not read hosted revisions for resume brief ${doc.subject}/${doc.slug}: ${message}; consume again when the hosted record is reachable`,
    )
  }
  const latest = revisions
    .filter((revision) => revision.op !== 'consume')
    .sort((left, right) => String(right.at).localeCompare(String(left.at)))[0]
  if (!latest) return null
  if (typeof latest.sessionId === 'string' && latest.sessionId) return latest.sessionId
  return typeof latest.id === 'string' ? storedDocRevisionAuthorSession(latest.id, database) : null
}
