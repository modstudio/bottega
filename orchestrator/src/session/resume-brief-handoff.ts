// concern: resume brief handoff adapter
/** Resolves a consumed brief's author and attempts a consent-relaxed session adoption. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, sessionId } from '../database/db.ts'
import { hostedDocClient } from '../doc/doc-hosted-client.ts'
import type { Doc } from '../doc/doc-read-store.ts'
import { currentRecordWriteDecision } from '../record/record-write-authority.ts'
import type { SessionProcessProbe } from '../run/session-liveness-adapter.ts'
import { adoptSessionRuns, type SessionAdoptionReport } from './session-adopt.ts'

export type ResumeBriefHandoff = {
  authorSession: string | null
  status: 'moved' | 'skipped' | 'refused'
  report: SessionAdoptionReport | null
  lines: string[]
}

async function earliestAuthorSession(doc: Doc, database: Database): Promise<string | null> {
  const local = database
    .query<{ session_id: string }, [string]>(
      `SELECT session_id FROM doc_revision
       WHERE doc_record_id=? AND session_id IS NOT NULL
       ORDER BY number LIMIT 1`,
    )
    .get(doc.record_id)
  if (local?.session_id) return local.session_id
  if (currentRecordWriteDecision(database) !== 'hosted') return null
  const revisions = await (await hostedDocClient(doc.scope, doc.subject)).listRevisions(
    doc.record_id,
  )
  return (
    (revisions
      .filter((revision) => typeof revision.sessionId === 'string' && revision.sessionId)
      .sort((left, right) => String(left.at).localeCompare(String(right.at)))[0]?.sessionId as
      | string
      | undefined) ?? null
  )
}

export async function handoffConsumedResumeBrief(
  doc: Doc,
  options: { database?: Database; probe?: SessionProcessProbe; machine?: string } = {},
): Promise<ResumeBriefHandoff> {
  const database = options.database ?? db()
  let author: string | null
  try {
    author = await earliestAuthorSession(doc, database)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      authorSession: null,
      status: 'refused',
      report: null,
      lines: [`resume handoff failed: ${message}`],
    }
  }
  if (!author)
    return {
      authorSession: null,
      status: 'skipped',
      report: null,
      lines: ['resume handoff skipped: brief author session is unknown'],
    }
  const actor = sessionId(database)
  if (author === actor)
    return {
      authorSession: author,
      status: 'skipped',
      report: null,
      lines: ['resume handoff skipped: brief author is the current session'],
    }
  const command = `${PLATFORM_SLUG} session adopt ${author} --reason "resume brief ${doc.subject}/${doc.slug} consumed by ${actor ?? 'successor'}"`
  try {
    const report = adoptSessionRuns(
      author,
      `resume brief ${doc.subject}/${doc.slug} consumed by ${actor}`,
      { consent: 'resume-handoff', database, probe: options.probe, machine: options.machine },
    )
    return {
      authorSession: author,
      status: 'moved',
      report,
      lines: report.runs.length
        ? [
            `resume handoff moved ${report.totalRuns} run(s) and ${report.totalTurns} turn(s) from ${author} to ${report.toSession}`,
          ]
        : [`resume handoff: session ${author} owns no runs`],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      authorSession: author,
      status: 'refused',
      report: null,
      lines: [`resume handoff did not move runs: ${message}; run ${command}`],
    }
  }
}
